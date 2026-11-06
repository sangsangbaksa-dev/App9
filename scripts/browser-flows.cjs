const assert=require('node:assert/strict');
module.exports=async function(page,base){
 await page.clock.install({time:new Date('2026-02-01T12:00:00+09:00')});
 await page.goto(base+'/');await page.click('#addBtn');await page.fill('#fName','월말 구독');await page.fill('#fAmt','10000');await page.fill('#fDate','2026-01-31');
 await page.click('#subForm [type=submit]');
 const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('renewal-ledger:v1')));
 assert.equal((await saved())[0].nextDate,'2026-02-28');
 await page.reload();await page.clock.setSystemTime(new Date('2026-03-01T12:00:00+09:00'));await page.reload();
 assert.equal((await saved())[0].nextDate,'2026-03-31','A saved month-end renewal must not drift');
 await page.getByRole('button',{name:'월말 구독 수정',exact:true}).click();await page.fill('#fNotes','메모 수정');await page.click('#subForm [type=submit]');
 assert.equal((await saved())[0].renewalAnchor,'2026-01-31');
 await page.fill('#budgetInput','50000');await page.click('#budgetForm [type=submit]');
 await page.setInputFiles('#importFile',{name:'empty-budget.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({app:'renewal-ledger',version:2,budget:0,subscriptions:[]}))});
 await page.click('#confirmOk');await page.waitForFunction(()=>localStorage.getItem('renewal-ledger:budget')==='0');assert.equal(await page.evaluate(()=>localStorage.getItem('renewal-ledger:budget')),'0');

 await page.getByRole('button',{name:'월말 구독 수정',exact:true}).click();await page.fill('#fDate','2026-03-15');await page.click('#subForm [type=submit]');
 await page.clock.setSystemTime(new Date('2026-04-01T12:00:00+09:00'));await page.reload();assert.equal((await saved())[0].nextDate,'2026-04-15');
};
