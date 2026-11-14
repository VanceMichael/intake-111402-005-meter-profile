import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect,registerValue} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('寄存器倍率不修改原始值', async () => {
  const rows = await collect(client);
  assert.equal(rows[0].value, 125);
  assert.equal(rows[0].raw, 1250);
  assert.throws(() => registerValue({value:1,scaler:0.5}), /invalid register/);
});
