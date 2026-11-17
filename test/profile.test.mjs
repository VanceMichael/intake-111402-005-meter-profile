import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {Archive} from '../src/archive.mjs';
import {readCursor,writeCursor} from '../src/cursor.mjs';
import {collect,collectProfile,collectProfileByTime,reconcileProfile,clockInstant,uninterpretableIntervals} from '../src/reader.mjs';

const DAY = {from:'2026-10-25T00:00:00Z',to:'2026-10-26T00:00:00Z'};

test('每段曲线按自己的捕获版本解释，原始值与解释依据保留', async () => {
  const source = await createSource({scenario:'clock-fold'});
  try {
    const client = createClient(source.origin);
    const {rows,nextEntry,meterEpoch} = await collectProfile(client);
    assert.equal(meterEpoch,'e1');
    assert.equal(nextEntry,null);
    assert.equal(rows.length,2);
    const [first,second] = rows;
    assert.equal(first.captureVersion,'c1');
    assert.deepEqual(first.raw,[1250]);
    assert.equal(first.values[0].value,125);
    assert.equal(first.values[0].unit,'kWh');
    assert.equal(first.values[0].scaler,-1);
    assert.equal(first.clock.status,0);
    assert.equal(first.capture.columns[0].logicalName,'energy');
    assert.equal(second.captureVersion,'c2');
    assert.deepEqual(second.raw,[1251]);
    assert.equal(second.values[0].value,125100);
    assert.equal(second.values[0].unit,'Wh');
    assert.equal(second.values[0].scaler,2);
    assert.notEqual(second.values[0].value,second.raw[0] * 10 ** first.capture.columns[0].scaler);
  } finally {await source.close();}
});

test('夏令时回拨的相同表面时间不互相覆盖，两条路径对账一致', async () => {
  const source = await createSource({scenario:'clock-fold'});
  const directory = await mkdtemp(join(tmpdir(),'profile-'));
  try {
    const client = createClient(source.origin);
    const {rows} = await collectProfile(client);
    assert.equal(rows[0].clock.local,rows[1].clock.local);
    assert.notEqual(rows[0].instant,rows[1].instant);
    assert.notEqual(rows[0].id,rows[1].id);
    const archive = new Archive(directory);
    await archive.put(rows,{source:'local'});
    assert.equal((await archive.list()).length,2);
    const byTime = await collectProfileByTime(client,DAY);
    assert.equal(byTime.rows.length,2);
    const report = reconcileProfile(rows,byTime.rows);
    assert.equal(report.consistent,true);
    assert.equal(report.matched.length,2);
    assert.deepEqual(report.mismatches,[]);
  } finally {await source.close();await rm(directory,{recursive:true,force:true});}
});

test('按时间筛选与按行补读对账，覆盖差异与内容漂移可区分', async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const byEntries = await collectProfile(client);
    const byTime = await collectProfileByTime(client,DAY);
    assert.equal(byTime.complete,true);
    const report = reconcileProfile(byEntries.rows,byTime.rows);
    assert.equal(report.consistent,true);
    assert.deepEqual(report.onlyInEntries,[]);
    assert.deepEqual(report.onlyInTime,[]);
    assert.deepEqual([...report.matched].sort(),byEntries.rows.map(row => row.id).sort());
    const narrow = await collectProfileByTime(client,{from:'2026-10-25T00:31:00Z',to:'2026-10-26T00:00:00Z'});
    const partial = reconcileProfile(byEntries.rows,narrow.rows);
    assert.equal(partial.consistent,true);
    assert.deepEqual(partial.onlyInEntries,[byEntries.rows[0].id]);
    const tampered = structuredClone(byTime.rows);
    tampered[0].values[0].value = 999;
    const drift = reconcileProfile(byEntries.rows,tampered);
    assert.equal(drift.consistent,false);
    assert.equal(drift.mismatches.length,1);
    assert.equal(drift.mismatches[0].id,byEntries.rows[0].id);
    const duplicate = reconcileProfile([byEntries.rows[0],byEntries.rows[0]],[]);
    assert.equal(duplicate.consistent,false);
    assert.deepEqual(duplicate.duplicateEntries,[byEntries.rows[0].id]);
  } finally {await source.close();}
});

test('设备拒绝旧捕获定义时标出不可解释区间，不用当前定义补空', async () => {
  const source = await createSource({scenario:'capture-retired'});
  try {
    const client = createClient(source.origin);
    const {rows,uninterpretable} = await collectProfile(client);
    assert.equal(rows.length,2);
    const [retired,current] = rows;
    assert.equal(retired.captureVersion,'c0');
    assert.equal(retired.interpretable,false);
    assert.equal(retired.cause.reason,'capture-refused');
    assert.equal(retired.cause.status,404);
    assert.deepEqual(retired.raw,[1249]);
    assert.ok(!('values' in retired) && !('capture' in retired));
    assert.equal(current.interpretable,true);
    assert.equal(current.values[0].value,125);
    assert.deepEqual(uninterpretable,[{fromEntry:1,toEntry:1,count:1,captureVersions:['c0'],reasons:['capture-refused']}]);
    const byTime = await collectProfileByTime(client,{from:'2026-10-24T00:00:00Z',to:'2026-10-26T00:00:00Z'});
    assert.equal(reconcileProfile(rows,byTime.rows).consistent,true);
  } finally {await source.close();}
});

test('续接上次未读完的区段，不重新抄整张表', async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const first = await collectProfile(client,{fromEntry:1,pageLimit:1});
    assert.deepEqual(first.rows.map(row => row.entry),[1]);
    assert.equal(first.complete,false);
    assert.equal(first.nextEntry,2);
    const resumed = await collectProfile(client,{cursor:{meterEpoch:first.meterEpoch,nextEntry:first.nextEntry}});
    assert.deepEqual(resumed.rows.map(row => row.entry),[2]);
    assert.equal(resumed.complete,true);
    assert.equal(resumed.nextEntry,null);
    const done = await collectProfile(client,{cursor:{meterEpoch:'e1',nextEntry:null}});
    assert.deepEqual(done.rows,[]);
    const replaced = await collectProfile(client,{cursor:{meterEpoch:'e0',nextEntry:2}});
    assert.deepEqual(replaced.rows.map(row => row.entry),[1,2]);
    const audit = await client('/__audit');
    const pages = audit.requests.filter(request => request.path === '/profiles/load/entries').map(request => request.query.fromEntry);
    assert.deepEqual(pages,['1','2','1','2']);
  } finally {await source.close();}
});

test('分次领取中断后从检查点续接，不重复收件', async () => {
  const source = await createSource();
  const directory = await mkdtemp(join(tmpdir(),'intake-'));
  try {
    const client = createClient(source.origin);
    const archive = new Archive(directory);
    const chunk = async () => {
      const cursor = await readCursor(directory);
      const profile = await collectProfile(client,{cursor,pageLimit:1});
      await archive.put(profile.rows,{source:'local',adapter:'current'});
      await writeCursor(directory,{meterEpoch:profile.meterEpoch,nextEntry:profile.nextEntry});
      return profile;
    };
    const first = await chunk();
    assert.equal(first.complete,false);
    assert.equal((await archive.list()).length,1);
    const finished = await chunk();
    assert.equal(finished.complete,true);
    const again = await chunk();
    assert.equal(again.rows.length,0);
    assert.equal((await archive.list()).length,2);
  } finally {await source.close();await rm(directory,{recursive:true,force:true});}
});

test('游标文件读写与损坏恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(),'cursor-'));
  try {
    assert.equal(await readCursor(directory),null);
    await writeCursor(directory,{meterEpoch:'e1',nextEntry:2});
    assert.deepEqual(await readCursor(directory),{meterEpoch:'e1',nextEntry:2});
    await writeCursor(directory,{meterEpoch:'e1',nextEntry:null});
    assert.deepEqual(await readCursor(directory),{meterEpoch:'e1',nextEntry:null});
    await assert.rejects(writeCursor(directory,{meterEpoch:'e1'}),/invalid cursor/);
    const {writeFile} = await import('node:fs/promises');
    await writeFile(join(directory,'profile-cursor.json'),'{损坏');
    assert.equal(await readCursor(directory),null);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('收件主流程两段运行：续读不重复收件', async () => {
  const source = await createSource();
  const directory = await mkdtemp(join(tmpdir(),'intake-'));
  try {
    const client = createClient(source.origin);
    const archive = new Archive(directory);
    const run = async () => {
      const cursor = await readCursor(directory);
      const profile = await collectProfile(client,{cursor});
      const result = await archive.put(profile.rows,{source:'local',adapter:'current'});
      await writeCursor(directory,{meterEpoch:profile.meterEpoch,nextEntry:profile.nextEntry});
      return {...result,fetched:profile.rows.length};
    };
    const first = await run();
    assert.equal(first.added,2);
    const second = await run();
    assert.equal(second.fetched,0);
    assert.equal(second.added,0);
    assert.equal((await archive.list()).length,2);
  } finally {await source.close();await rm(directory,{recursive:true,force:true});}
});

test('collect 收件链路包含寄存器与负荷曲线', async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const rows = await collect(client);
    assert.equal(rows[0].id,'1.0.1.8.0.255');
    const profile = rows.filter(row => row.kind === 'load-profile-entry');
    assert.equal(profile.length,2);
    assert.ok(profile.every(row => row.interpretable));
  } finally {await source.close();}
});

test('来源数据异常边界', async () => {
  assert.equal(clockInstant({local:'2026-10-25T02:30:00',deviation:-120}),'2026-10-25T00:30:00.000Z');
  const row = {entry:1,captureVersion:'c1',clock:{local:'2026-10-25T00:00:00',deviation:0,status:0},values:[1]};
  const columns = [{logicalName:'energy',attribute:2,scaler:0,unit:'Wh'}];
  const fake = routes => async path => {
    if (path in routes) return typeof routes[path] === 'function' ? routes[path]() : routes[path];
    throw new Error(`unexpected ${path}`);
  };
  const header = {'/profiles/load':{meterEpoch:'e1'}};
  await assert.rejects(collectProfile(fake({...header,'/profiles/load/entries?fromEntry=1':{meterEpoch:'e1',rows:[{entry:'x'}],nextEntry:null}})),/invalid profile row/);
  await assert.rejects(collectProfile(fake({...header,'/profiles/load/entries?fromEntry=1':{meterEpoch:'e1',rows:[],nextEntry:1}})),/pagination loop/);
  await assert.rejects(collectProfile(fake({...header,
    '/profiles/load/entries?fromEntry=1':{meterEpoch:'e1',rows:[row],nextEntry:2},
    '/profiles/load/entries?fromEntry=2':{meterEpoch:'e2',rows:[],nextEntry:null},
    '/captures/c1':{columns},
  })),/meter epoch changed/);
  const mismatch = await collectProfile(fake({...header,
    '/profiles/load/entries?fromEntry=1':{meterEpoch:'e1',rows:[row],nextEntry:null},
    '/captures/c1':{columns:[...columns,{logicalName:'extra',attribute:2,scaler:0,unit:'Wh'}]},
  }));
  assert.equal(mismatch.rows[0].interpretable,false);
  assert.equal(mismatch.rows[0].cause.reason,'capture-column-mismatch');
  const invalid = await collectProfile(fake({...header,
    '/profiles/load/entries?fromEntry=1':{meterEpoch:'e1',rows:[row],nextEntry:null},
    '/captures/c1':{columns:[{logicalName:'energy'}]},
  }));
  assert.equal(invalid.rows[0].interpretable,false);
  assert.equal(invalid.rows[0].cause.reason,'capture-invalid');
  const noFetch = async () => {throw new Error('no fetch expected');};
  await assert.rejects(collectProfileByTime(noFetch,{from:'x',to:'y'}),/time range/);
  await assert.rejects(collectProfileByTime(noFetch,{from:'2026-10-26T00:00:00Z',to:'2026-10-25T00:00:00Z'}),/time range/);
});

test('不可解释区间按相邻行归并', () => {
  const rows = [
    {entry:1,interpretable:false,captureVersion:'c0',cause:{reason:'capture-refused'}},
    {entry:2,interpretable:false,captureVersion:'c0',cause:{reason:'capture-refused'}},
    {entry:3,interpretable:true},
    {entry:4,interpretable:false,captureVersion:'c1',cause:{reason:'capture-invalid'}},
  ];
  assert.deepEqual(uninterpretableIntervals(rows),[
    {fromEntry:1,toEntry:2,count:2,captureVersions:['c0'],reasons:['capture-refused']},
    {fromEntry:4,toEntry:4,count:1,captureVersions:['c1'],reasons:['capture-invalid']},
  ]);
});
