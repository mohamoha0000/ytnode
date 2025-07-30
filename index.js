const express = require('express');
const puppeteer = require('puppeteer');

const app = express();

app.get('/', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl || !targetUrl.startsWith('http')) {
        return res.status(400).send('❌ الرجاء توفير رابط صحيح عبر ?url=https://...');
    }

    try {
        const browser = await puppeteer.launch({
            headless: 'new', // استخدام وضع خفي بدون واجهة رسومية
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // مهم لـ Render وبيئات السيرفر
        });

        const page = await browser.newPage();

        // استخدام User-Agent حقيقي
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36");

        // فتح الرابط
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // جلب محتوى الصفحة
        const content = await page.content();

        await browser.close();

        res.send(content); // إرجاع HTML كامل للصفحة

    } catch (err) {
        console.error(err);
        res.status(500).send('❌ حدث خطأ أثناء فتح الرابط.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ API تعمل على المنفذ ${PORT}`);
});
