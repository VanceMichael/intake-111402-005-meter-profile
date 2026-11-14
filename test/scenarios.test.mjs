import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('clock-fold');
const rows = (await client('/profiles/load/entries?fromEntry=1')).rows;
assert.equal(rows[0].clock.local,rows[1].clock.local);
assert.notEqual(rows[0].clock.deviation,rows[1].clock.deviation);
assert.notEqual(rows[0].captureVersion,rows[1].captureVersion);
} finally {await source.close();}
});
