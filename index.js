const puppeteer = require('puppeteer');
const axios = require('axios');
const vm = require('vm');
const express = require('express');
const app = express();

function parseQueryString(qs) {
  const params = new URLSearchParams(qs);
  let result = {};
  for (const [k, v] of params.entries()) {
    result[k] = v;
  }
  return result;
}

async function getDecipherFunction(playerJSUrl) {
    try {
        const res = await axios.get(playerJSUrl, { timeout: 10000 });
        if (!res.data) throw new Error("Failed to fetch player script");
        const body = res.data;

        // Find decipher function name
        let fnNameMatch = body.match(/\.sig\|\|([a-zA-Z0-9$]+)\(/)
            || body.match(/signature=function\((\w+)\)/)
            || body.match(/function ([a-zA-Z0-9$]+)\(\w+\)\{[\s\S]+?split\(""\)[^}]+/);

        let fnName;
        if (fnNameMatch) {
            fnName = fnNameMatch[1];
        } else {
            const fnRegex = /function ([a-zA-Z0-9$]+)\((\w+)\)\{([\s\S]+?split\(""\)[^}]+)\}/g;
            let match;
            while ((match = fnRegex.exec(body)) !== null) {
                if (match[3].includes('split("")') && match[3].includes('join("")')) {
                    fnName = match[1];
                    break;
                }
            }
        }

        if (!fnName) throw new Error("لم أجد دالة فك التوقيع");

        const escapedFnName = fnName.replace(/\$/g, '\\$');
        const fnRegex = new RegExp(`(?:function ${escapedFnName}|var ${escapedFnName}=function)\\((\\w+)\\)\\{([\\s\\S]+?)\\}`);
        const fnMatch = body.match(fnRegex);

        if (!fnMatch) throw new Error("لم أجد دالة فك التوقيع");

        const fnArg = fnMatch[1];
        const fnBody = fnMatch[2];

        // Extract helper object name (more flexible pattern)
        const objNameMatch = fnBody.match(/;([a-zA-Z0-9$]+)\./);
        if (!objNameMatch) {
            console.log("Helper object name not found. fnBody sample:", fnBody.slice(0, 200));
            throw new Error("لم أجد كائن العمليات المساعدة");
        }

        const objName = objNameMatch[1].replace(/\$/g, '\\$');
        // Try primary regex for helper object
        let objRegex = new RegExp(`var ${objName}=\\{([\\s\\S]+?)\\}(?:;|,|$)`, 's');
        let objMatch = body.match(objRegex);

        if (!objMatch) {
            // Fallback 1: Broader object search with helper functions
            objRegex = new RegExp(`var ([a-zA-Z0-9$]+)=\\{[^}]+?(?:reverse|splice|slice|shift|push)[^}]+\\}(?:;|,|$)`, 's');
            objMatch = body.match(objRegex);

            if (!objMatch) {
                // Fallback 2: Even broader search for any object used in fnBody
                objRegex = new RegExp(`var ${objName}=\\{[^}]+\\}(?:;|,|$)`, 's');
                objMatch = body.match(objRegex);

                if (!objMatch) {
                    // Log surrounding code for manual inspection
                    const objIndex = body.indexOf(objName);
                    console.log("Helper object not found. objName:", objName);
                    console.log("Body sample near objName:", 
                        body.slice(Math.max(0, objIndex - 200), objIndex + 200));
                    throw new Error("لم أجد جسم كائن العمليات المساعدة");
                }
            }
            console.log("Using fallback object name:", objMatch[1]);
        }

        const objBody = objMatch[0];

        // Ensure helper functions are valid
        if (!objBody.includes('function') || !/:\s*function/.test(objBody)) {
            console.log("Invalid helper object (no functions found):", objBody.slice(0, 200));
            throw new Error("كائن العمليات المساعدة غير صالح");
        }

        const fullCode = `
            ${objBody}
            function ${fnName}(${fnArg}) {${fnBody}}
            ${fnName}
        `;

        const script = new vm.Script(fullCode);
        const sandbox = {};
        vm.createContext(sandbox);
        script.runInContext(sandbox);

        return sandbox[fnName];
    } catch (error) {
        throw new Error(`Error in getDecipherFunction: ${error.message}`);
    }
}
async function decipherSignature(signature, decipherFn) {
    return decipherFn(signature);
}

app.get('/api/video', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl || !videoUrl.includes("youtube.com/watch")) {
    return res.status(400).send("رابط يوتيوب غير صالح");
  }

  try {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36");
    await page.goto(videoUrl, { waitUntil: 'networkidle2' });

    // جلب ytInitialPlayerResponse
    const ytInitialPlayerResponse = await page.evaluate(() => window.ytInitialPlayerResponse);
    if (!ytInitialPlayerResponse) throw new Error("لم أستطع الحصول على ytInitialPlayerResponse");

    // استخراج player.js URL
    const playerJsUrl = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src]'));
      const playerScript = scripts.find(s => s.src.includes('player') && s.src.includes('base.js'));
      return playerScript ? playerScript.src : null;
    });

    if (!playerJsUrl) throw new Error("لم أستطع إيجاد player.js URL");

    // الحصول على دالة فك التوقيع
    const decipherFn = await getDecipherFunction(playerJsUrl);

    // معالجة كل الصيغ لفك التوقيع
    const formats = [];
    const streamingData = ytInitialPlayerResponse.streamingData || {};

    const allFormats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];

    for (const fmt of allFormats) {
      let url = fmt.url;

      if (!url && fmt.signatureCipher) {
        // فك التوقيع signatureCipher
        const cipher = parseQueryString(fmt.signatureCipher);
        const s = cipher.s;
        const sp = cipher.sp || 'signature';
        const urlBase = cipher.url;

        const decodedS = await decipherSignature(s, decipherFn);

        url = `${urlBase}&${sp}=${decodedS}`;
      }

      formats.push({
        quality: fmt.qualityLabel || fmt.audioQuality || 'unknown',
        mimeType: fmt.mimeType,
        url,
        hasAudio: !!fmt.audioQuality,
        hasVideo: !!fmt.qualityLabel,
      });
    }

    await browser.close();

    res.json({ formats });

  } catch (error) {
    res.status(500).json({ error: error.message || error.toString() });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started at http://localhost:${PORT}`));
