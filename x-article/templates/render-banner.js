const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1500,height:600},deviceScaleFactor:2});
await p.goto('file://'+process.argv[2]);await p.waitForTimeout(1500);await p.evaluate(()=>document.fonts.ready);
await p.screenshot({path:process.argv[3]});await b.close();})();
