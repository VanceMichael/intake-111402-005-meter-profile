import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {
  clockInstantMs,collect,collectProfileEntries,collectProfileTime,dailyUsage,reconcile,scaleValue,uninterpretableRanges,
} from '../src/reader.mjs';

async function withSource(scenario,run) {
  const source = await createSource({scenario});
  try {return await run(createClient(source.origin),source);}
  finally {await source.close();}
}

test('每段曲线使用自身捕获版本的倍率，原始值保留',async () => {
  await withSource('clock-fold',async client => {
    const batch = await collectProfileEntries(client);
    const [first,second] = batch.rows;
    assert.equal(first.captureVersion,'c1');
    assert.equal(second.captureVersion,'c2');
    assert.deepEqual(first.raw,[1250]);
    assert.equal(first.columns[0].scaler,-1);
    assert.equal(first.columns[0].value,125);
    assert.equal(first.columns[0].unit,'kWh');
    assert.deepEqual(second.raw,[1251]);
    assert.equal(second.columns[0].scaler,2);
    assert.equal(second.columns[0].value,125100);
    assert.equal(second.columns[0].unit,'Wh');
    assert.equal(first.provenance.capture.version,'c1');
    assert.equal(second.provenance.capture.version,'c2');
    assert.equal(second.provenance.valueRule,'raw * 10 ** scaler');
  });
});

test('回拨日相同表面时间得到不同标识与绝对时刻',async () => {
  await withSource('clock-fold',async client => {
    const {rows} = await collectProfileEntries(client);
    assert.equal(rows[0].clock.local,rows[1].clock.local);
    assert.notEqual(rows[0].clock.deviation,rows[1].clock.deviation);
    assert.notEqual(rows[0].id,rows[1].id);
    assert.deepEqual(rows.map(row => row.clock.instant),['2026-10-25T00:30:00.000Z','2026-10-25T01:30:00.000Z']);
    assert.equal(clockInstantMs({local:'2026-10-25T02:30:00',deviation:-60}),Date.parse('2026-10-25T01:30:00Z'));
  });
});

test('按时间筛选与按行补读逐条对账',async () => {
  for (const scenario of ['normal','clock-fold']) {
    await withSource(scenario,async client => {
      const byEntry = await collectProfileEntries(client);
      const byTime = await collectProfileTime(client,{from:'2026-10-25T00:00:00Z',to:'2026-10-26T00:00:00Z'});
      const check = reconcile(byTime.rows,byEntry.rows);
      assert.equal(check.reconciled,true,scenario);
      assert.deepEqual(check.matched,byEntry.rows.map(row => row.id));
      assert.equal(byTime.window.semantics,'[from,to)');
    });
  }
});

test('旧定义被拒时标出不可解释区间且不回填当前定义',async () => {
  await withSource('capture-unavailable',async client => {
    const batch = await collectProfileEntries(client);
    assert.deepEqual(batch.rows.map(row => row.interpretable),[true,false,false]);
    assert.deepEqual(batch.rows.map(row => row.id),['e1:1','e1:2','e1:3']);
    assert.equal(batch.rows[1].raw[0],1251);
    assert.deepEqual(batch.rows[1].columns,[]);
    assert.match(batch.rows[1].reasons[0],/capture-definition-unavailable:404/);
    assert.deepEqual(batch.uninterpretable,[{
      meterEpoch:'e1',captureVersion:'c-old',fromEntry:2,toEntry:3,
      reason:'capture-definition-unavailable:404',
      reasons:['capture-definition-unavailable:404'],
      ids:['e1:2','e1:3'],
    }]);
    assert.equal(batch.provenance.captures['c-old'].available,false);
    assert.deepEqual(dailyUsage(batch.rows).map(bucket => bucket.total),[125]);
  });
});

test('续接未读完区段而不重抄整张表',async () => {
  await withSource('normal',async client => {
    const first = await collectProfileEntries(client,{maxPages:1});
    assert.equal(first.complete,false);
    assert.deepEqual(first.rows.map(row => row.id),['e1:1']);
    assert.equal(first.cursor.nextEntry,2);
    const second = await collectProfileEntries(client,{cursor:first.cursor});
    assert.equal(second.complete,true);
    assert.deepEqual(second.rows.map(row => row.id),['e1:2']);
    assert.equal(second.cursor.nextEntry,null);
    assert.equal(second.cursor.pages.length,2);
    const third = await collectProfileEntries(client,{cursor:second.cursor});
    assert.deepEqual(third.rows,[]);
    const all = await collectProfileEntries(client);
    assert.deepEqual([...first.rows,...second.rows].map(row => row.id),all.rows.map(row => row.id));
  });
});

test('collect 同时领取寄存器与历史曲线',async () => {
  await withSource('normal',async client => {
    const rows = await collect(client);
    assert.equal(rows[0].value,125);
    assert.deepEqual(rows.slice(1).map(row => row.id),['e1:1','e1:2']);
    const onlyProfile = await collect(client,{channel:'profile'});
    assert.deepEqual(onlyProfile.map(row => row.id),['e1:1','e1:2']);
    const windowed = await collect(client,{channel:'profile',time:{from:'2026-10-25T00:40:00Z',to:'2026-10-25T00:50:00Z'}});
    assert.deepEqual(windowed.map(row => row.id),['e1:2']);
  });
});

test('倍率换算保留十进制精度',() => {
  assert.equal(scaleValue(1251,-1),125.1);
  assert.equal(scaleValue(1250,0),1250);
  assert.equal(scaleValue(1251,2),125100);
  assert.equal(scaleValue(undefined,0),null);
  assert.deepEqual(uninterpretableRanges([{meterEpoch:'e1',captureVersion:'c1',entry:1,reasons:['x'],interpretable:false,id:'e1:1'}]),
    [{meterEpoch:'e1',captureVersion:'c1',fromEntry:1,toEntry:1,reason:'x',reasons:['x'],ids:['e1:1']}]);
});
