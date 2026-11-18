import {SourceError} from './transport.mjs';

const CLOCK_RULE = 'Date.parse(local + "Z") + deviation * 60000';
const VALUE_RULE = 'raw * 10 ** scaler';
const DEFAULT_MAX_PAGES = 1000;

export function registerValue(register) {
  if (!Number.isInteger(register.scaler) || !Number.isFinite(register.value)) throw new Error('invalid register');
  return {id:register.logicalName,raw:register.value,value:scaleValue(register.value,register.scaler),unit:register.unit};
}

/*
 * 表时钟的 local 是没有时区的表面时间。来源契约按
 * Date.parse(local + 'Z') + deviation 分钟把它映射到绝对时刻。
 * 时间筛选与按行补读必须使用完全相同的算法，否则两份结果无法对账。
 * 夏令时回拨时两个 entry 的 local 相同、deviation 不同，绝对时刻因此可区分。
 */
export function clockInstantMs(clock) {
  if (!clock || typeof clock.local !== 'string' || !clock.local) return null;
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(clock.local);
  const base = Date.parse(hasZone ? clock.local : `${clock.local}Z`);
  if (!Number.isFinite(base)) return null;
  const deviation = Number.isFinite(clock.deviation) ? clock.deviation : 0;
  return base + deviation * 60000;
}

export function clockInstant(clock) {
  const ms = clockInstantMs(clock);
  return ms === null ? null : new Date(ms).toISOString();
}

export const clockTime = clockInstant;

function buildClock(clock) {
  if (!clock || typeof clock !== 'object') {
    return {local:null,deviation:null,status:null,instantMs:null,instant:null,valid:false};
  }
  const instantMs = clockInstantMs(clock);
  return {
    local:clock.local ?? null,
    deviation:Number.isFinite(clock.deviation) ? clock.deviation : null,
    status:clock.status ?? null,
    instantMs,
    instant:instantMs === null ? null : new Date(instantMs).toISOString(),
    valid:instantMs !== null,
  };
}

function normalizeTime(value,name) {
  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && value) {
    const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z`
      : (/(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
    ms = Date.parse(text);
  }
  if (!Number.isFinite(ms)) throw new Error(`${name} time required`);
  return new Date(ms).toISOString();
}

function normalizeEntry(value,name) {
  const entry = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(entry) || entry < 1) throw new Error(`${name} entry required`);
  return entry;
}

function profileLink(data) {
  if (!data || typeof data !== 'object') throw new Error('invalid profile metadata');
  if (typeof data.captureVersion !== 'string' || !data.captureVersion) throw new Error('profile captureVersion required');
  return {
    meterEpoch:typeof data.meterEpoch === 'string' && data.meterEpoch ? data.meterEpoch : null,
    captureVersion:data.captureVersion,
    captureObjects:Array.isArray(data.captureObjects) ? data.captureObjects.slice() : null,
    entriesInUse:Number.isInteger(data.entriesInUse) ? data.entriesInUse : null,
  };
}

/*
 * captureObjects 描述捕获列的顺序，/captures/:version 给出该版本各列的量纲。
 * 两者长度一致时按位置对应；否则只按 logicalName 精确对应。缺列即为不可解释，
 * 绝不从当前版本或相邻版本补列。
 */
function alignColumns(captureObjects,columns) {
  if (!Array.isArray(columns) || columns.length === 0) return null;
  if (!Array.isArray(captureObjects) || captureObjects.length === 0) {
    return columns.map((column,index) => ({object:column?.logicalName ?? null,position:index,column}));
  }
  const objects = captureObjects.map((object,index) => ({object,position:index}))
    .filter(item => item.object !== 'clock');
  if (columns.length === objects.length) {
    return objects.map((item,index) => ({...item,column:columns[index] ?? null}));
  }
  const byName = new Map();
  for (const column of columns) {
    const name = column?.logicalName;
    if (typeof name !== 'string' || byName.has(name)) continue;
    byName.set(name,column);
  }
  return objects.map(item => ({...item,column:byName.get(item.object) ?? null}));
}

/*
 * raw 原值保留；换算只做十进制移位，并收敛二进制浮点噪声
 * （例如 1251 * 0.1 应为 125.1，而不是 125.10000000000001）。
 */
export function scaleValue(raw,scaler) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(scaler)) return null;
  const value = raw * 10 ** scaler;
  if (!Number.isFinite(value)) return null;
  const shifted = Number(value.toPrecision(15));
  return Object.is(shifted,-0) ? 0 : shifted;
}

function interpretColumn(raw,descriptor,object,position) {
  const column = {
    position,
    object,
    logicalName:descriptor?.logicalName ?? object ?? null,
    attribute:descriptor?.attribute ?? null,
    scaler:descriptor?.scaler ?? null,
    unit:descriptor?.unit ?? null,
    raw:raw ?? null,
    value:null,
    interpretable:false,
    reason:null,
  };
  if (!descriptor) return {...column,reason:'capture-column-missing'};
  if (!Number.isInteger(descriptor.scaler)) return {...column,reason:'invalid-scaler'};
  const value = scaleValue(raw,descriptor.scaler);
  if (value === null) return {...column,reason:'invalid-raw-value'};
  return {...column,value,interpretable:true};
}

async function loadCapture(client,version,cache) {
  if (cache.has(version)) return cache.get(version);
  const request = `/captures/${encodeURIComponent(version)}`;
  const promise = (async () => {
    let data;
    try {data = await client(request);}
    catch(error) {
      if (!(error instanceof SourceError)) throw error;
      return {version,request,available:false,status:error.status,reason:`capture-definition-unavailable:${error.status}`};
    }
    if (!Array.isArray(data?.columns)) {
      return {version,request,available:false,status:200,reason:'capture-definition-invalid'};
    }
    return {version,request,available:true,columns:data.columns};
  })();
  cache.set(version,promise);
  return promise;
}

async function loadProfile(client) {
  const data = await client('/profiles/load');
  const profile = profileLink(data);
  const captures = new Map();
  const capture = await loadCapture(client,profile.captureVersion,captures);
  return {profile,captures,capture};
}

/*
 * 把一行来源记录变成可对账的原件：
 * - id 由 meterEpoch + entry 组成，与表面时间无关，夏令时回拨不会互相覆盖；
 * - raw 原值不动，解释结果连同所用捕获列、倍率、单位与时钟依据一起保存；
 * - 缺定义或列不齐时只记录不可解释原因，不从当前定义补值。
 */
async function interpretRow(client,row,profile,captures,context) {
  const entry = Number.isInteger(row?.entry) ? row.entry : null;
  const version = typeof row?.captureVersion === 'string' && row.captureVersion ? row.captureVersion : null;
  const clock = buildClock(row?.clock);
  const reasons = [];
  const values = Array.isArray(row?.values) ? row.values.slice() : null;

  if (entry === null) reasons.push('invalid-entry');
  if (!version) reasons.push('capture-version-missing');
  if (!clock.valid) reasons.push('invalid-clock');
  if (!values) reasons.push('invalid-values');

  const capture = version ? await loadCapture(client,version,captures) : null;
  let columns = [];
  if (capture?.available) {
    const aligned = alignColumns(profile.captureObjects,capture.columns);
    if (!aligned) reasons.push('capture-columns-missing');
    else {
      columns = aligned.map(({object,position,column},index) =>
        interpretColumn(values ? values[index] : undefined,column,object,position));
      for (const column of columns) if (!column.interpretable) reasons.push(column.reason);
    }
  } else if (version) reasons.push(capture.reason);

  const id = entry === null ? `invalid:${profile.meterEpoch}:${context.sequence++}` : `${profile.meterEpoch}:${entry}`;
  return {
    id,
    kind:'load-profile-row',
    meterEpoch:profile.meterEpoch,
    entry,
    captureVersion:version,
    clock,
    values,
    raw:values,
    columns,
    interpretable:reasons.length === 0,
    reasons:[...new Set(reasons)],
    provenance:{
      source:context.source,
      meterEpoch:profile.meterEpoch,
      captureObjects:profile.captureObjects,
      capture:captureSummary(capture),
      clockRule:CLOCK_RULE,
      valueRule:VALUE_RULE,
    },
  };
}

function captureSummary(capture) {
  if (!capture) return null;
  return capture.available
    ? {version:capture.version,available:true,columns:capture.columns,request:capture.request}
    : {version:capture.version,available:false,reason:capture.reason,status:capture.status,request:capture.request};
}

/*
 * 对账用来源凭据只包含来源事实，不包含本次是"按时间"还是"按行"领取。
 * 同一条来源记录经两条路径收取时摘要一致，归档不会产生重复版本。
 */
function profileProvenance(profile,capture,source) {
  return {
    kind:'load-profile',
    source:source ?? null,
    meterEpoch:profile.meterEpoch,
    captureVersion:profile.captureVersion,
    captureObjects:profile.captureObjects,
    entriesInUse:profile.entriesInUse,
    capture:captureSummary(capture),
    captures:{},
    clockRule:CLOCK_RULE,
    valueRule:VALUE_RULE,
  };
}

/*
 * 行内已带每段实际用的列与倍率；这里再按版本汇总一次，
 * 让整批原件也能看出哪些旧定义取到了、哪些被来源拒绝。
 * 汇总只依赖来源事实，因此同一条记录经按时间/按行收取时摘要一致。
 */
async function recordCaptures(client,rows,captures,provenance) {
  const versions = [...new Set(rows.map(row => row.captureVersion).filter(Boolean))];
  for (const version of versions) {
    const capture = await loadCapture(client,version,captures);
    provenance.captures[version] = captureSummary(capture);
  }
}

async function interpretRows(client,rawRows,profile,captures,provenance) {
  const context = {sequence:0,source:provenance.source};
  const rows = [];
  for (const rawRow of rawRows) rows.push(await interpretRow(client,rawRow,profile,captures,context));
  await recordCaptures(client,rows,captures,provenance);
  return rows;
}

export function sortRows(rows) {
  return rows.slice().sort((left,right) => {
    const leftMs = left.clock?.instantMs;
    const rightMs = right.clock?.instantMs;
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
    if (Number.isInteger(left.entry) && Number.isInteger(right.entry) && left.entry !== right.entry) return left.entry - right.entry;
    return String(left.id).localeCompare(String(right.id));
  });
}

/*
 * 把不可解释的连续区段折叠成区间，按 meterEpoch 内的 entry 表示。
 * 这些区间是"来源没给定义"的凭据，不得用当前捕获版本回填。
 */
export function uninterpretableRanges(rows) {
  const ranges = [];
  let current = null;
  for (const row of sortRows(rows).filter(item => !item.interpretable)) {
    const key = `${row.meterEpoch}\u0000${row.captureVersion}`;
    const reason = row.reasons.join(',');
    if (current && current.key === key && current.reason === reason &&
        Number.isInteger(row.entry) && current.toEntry + 1 === row.entry) {
      current.toEntry = row.entry;
      current.ids.push(row.id);
      continue;
    }
    current = {
      key,
      meterEpoch:row.meterEpoch,
      captureVersion:row.captureVersion,
      fromEntry:row.entry,
      toEntry:row.entry,
      reason,
      reasons:row.reasons.slice(),
      ids:[row.id],
    };
    ranges.push(current);
  }
  return ranges.map(({key,...range}) => range);
}

function assertSingleValue(row) {
  if (!row.columns || row.columns.length !== 1) throw new Error('dailyUsage requires one captured value column');
}

/*
 * 按表时钟日期汇总。只有单一数值列且可解释的行参与汇总；
 * 回拨日的表面时间可能重复，但 entry 与绝对时刻不同，二者都计入当天。
 */
export function dailyUsage(rows) {
  const buckets = new Map();
  for (const row of sortRows(rows.filter(item => item.interpretable))) {
    assertSingleValue(row);
    const day = row.clock.local.slice(0,10);
    const unit = row.columns[0].unit;
    const key = `${day}\u0000${unit}`;
    if (!buckets.has(key)) buckets.set(key,{day,unit,first:row,last:row,total:0,consumption:0});
    const bucket = buckets.get(key);
    bucket.last = row;
    bucket.total += row.columns[0].value;
  }
  for (const bucket of buckets.values()) {
    bucket.consumption = bucket.last.columns[0].value - bucket.first.columns[0].value;
  }
  return [...buckets.values()].sort((left,right) =>
    left.day.localeCompare(right.day) || String(left.unit).localeCompare(String(right.unit)));
}

function rangeResult(batch) {
  return {
    ...batch,
    uninterpretable:uninterpretableRanges(batch.rows),
  };
}

/*
 * 按 entry 顺序补读，cursor 可跨调用续接：
 *   const first = await collectProfileEntries(client,{maxPages:1});
 *   const rest  = await collectProfileEntries(client,{cursor:first.cursor});
 * complete=false 表示来源还有下一页，cursor.nextEntry 指向下一段起点；
 * complete=true 时 cursor.nextEntry 为 null，再次续接不会重抄整张表。
 */
export async function collectProfileEntries(client,options = {}) {
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : DEFAULT_MAX_PAGES;
  const source = options.origin ?? null;
  const {profile,captures,capture} = await loadProfile(client);
  const provenance = profileProvenance(profile,capture,source);

  let cursor = null;
  if (options.cursor) {
    if (options.cursor.meterEpoch !== profile.meterEpoch) throw new Error('cursor meterEpoch changed');
    cursor = options.cursor;
  }
  if (cursor && cursor.nextEntry === null) {
    return rangeResult({
      kind:'load-profile',
      rows:[],
      profile:profileProvenance(profile,capture,source),
      capture:captureSummary(capture),
      pages:Array.isArray(cursor.pages) ? cursor.pages.slice() : [],
      cursor:{...cursor,pages:Array.isArray(cursor.pages) ? cursor.pages.slice() : []},
      complete:true,
      provenance,
    });
  }
  let fromEntry = cursor ? normalizeEntry(cursor.nextEntry,'cursor.nextEntry') : normalizeEntry(options.fromEntry ?? 1,'fromEntry');
  const rows = [];
  const pages = Array.isArray(cursor?.pages) ? cursor.pages.slice() : [];
  let complete = false;
  let lastEntry = cursor?.lastEntry ?? null;

  for (let page = 0; page < maxPages; page++) {
    const request = `/profiles/load/entries?fromEntry=${fromEntry}`;
    const data = await client(request);
    if (!data || !Array.isArray(data.rows)) throw new Error('invalid profile entries response');
    if (data.meterEpoch !== undefined && data.meterEpoch !== profile.meterEpoch) throw new Error('profile meterEpoch changed');
    const pageRows = await interpretRows(client,data.rows,profile,captures,provenance);
    rows.push(...pageRows);
    if (Number.isInteger(data.nextEntry)) lastEntry = data.nextEntry - 1;
    for (const row of pageRows) if (Number.isInteger(row.entry)) lastEntry = Math.max(lastEntry ?? row.entry,row.entry);
    pages.push({request,fromEntry,entries:pageRows.map(row => row.entry),nextEntry:data.nextEntry ?? null});

    const nextEntry = data.nextEntry;
    if (nextEntry === null || nextEntry === undefined) {complete = true;break;}
    if (!Number.isInteger(nextEntry) || nextEntry <= fromEntry) {
      throw new Error('profile source did not advance nextEntry');
    }
    fromEntry = nextEntry;
  }

  return rangeResult({
    kind:'load-profile',
    rows,
    profile:profileProvenance(profile,capture,source),
    capture:captureSummary(capture),
    pages,
    cursor:{meterEpoch:profile.meterEpoch,nextEntry:complete ? null : fromEntry,lastEntry,pages:pages.slice()},
    complete,
    provenance,
  });
}

/*
 * 按带偏差的绝对时间窗口筛选同一档案。返回行与按行补读具有相同 id、
 * 相同 clock.instant 和相同解释依据，可直接逐条对账。
 */
export async function collectProfileTime(client,options = {}) {
  const from = normalizeTime(options.from,'from');
  const to = normalizeTime(options.to,'to');
  if (Date.parse(from) >= Date.parse(to)) throw new Error('time range required');
  const source = options.origin ?? null;
  const {profile,captures,capture} = await loadProfile(client);
  const provenance = profileProvenance(profile,capture,source);
  const request = `/profiles/load/time?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const data = await client(request);
  if (!data || !Array.isArray(data.rows)) throw new Error('invalid profile time response');
  if (data.meterEpoch !== undefined && data.meterEpoch !== profile.meterEpoch) throw new Error('profile meterEpoch changed');
  const rows = await interpretRows(client,data.rows,profile,captures,provenance);
  return rangeResult({
    kind:'load-profile',
    rows,
    profile:profileProvenance(profile,capture,source),
    capture:captureSummary(capture),
    window:{from,to,semantics:'[from,to)'},
    sourceComplete:data.complete !== false,
    provenance,
  });
}

/*
 * 逐条比对按时间与按行领取的结果。id 是 meterEpoch+entry，
 * 夏令时回拨不会因表面时间相同而合并或覆盖。
 */
function reconcileRow(row) {
  return {
    id:row.id,
    meterEpoch:row.meterEpoch,
    entry:row.entry,
    captureVersion:row.captureVersion,
    clock:row.clock,
    raw:row.raw,
    columns:row.columns,
    interpretable:row.interpretable,
    reasons:row.reasons,
    provenance:row.provenance,
  };
}

export function reconcile(timeRows,entryRows) {
  const byId = rows => {
    const map = new Map();
    const duplicates = [];
    for (const row of rows) {
      if (map.has(row.id)) duplicates.push(row.id);
      else map.set(row.id,row);
    }
    return {map,duplicates};
  };
  const left = byId(timeRows);
  const right = byId(entryRows);
  const ids = [...new Set([...left.map.keys(),...right.map.keys()])].sort();
  const matched = [];
  const missingInTime = [];
  const missingInEntries = [];
  const conflicts = [];
  for (const id of ids) {
    const timeRow = left.map.get(id);
    const entryRow = right.map.get(id);
    if (!timeRow) missingInTime.push(id);
    else if (!entryRow) missingInEntries.push(id);
    else if (JSON.stringify(reconcileRow(timeRow)) === JSON.stringify(reconcileRow(entryRow))) matched.push(id);
    else conflicts.push({id,time:timeRow,entry:entryRow});
  }
  const duplicates = [...new Set([...left.duplicates,...right.duplicates])];
  return {matched,missingInTime,missingInEntries,conflicts,duplicates,
    reconciled:duplicates.length === 0 && missingInTime.length === 0 &&
      missingInEntries.length === 0 && conflicts.length === 0};
}

/*
 * 收件入口：保留寄存器读取，同时接入历史负荷曲线。
 * options.time 给 {from,to} 时按绝对时间筛选，否则按 entry 顺序补读；
 * options.cursor 用于续接上一次未读完的区段。
 */
export async function collect(client,options = {}) {
  const channel = options.channel ?? 'all';
  const rows = channel === 'profile' ? [] : [registerValue(await client('/register'))];
  if (channel === 'register') return rows;
  if (options.time) {
    const {from,to} = options.time;
    rows.push(...(await collectProfileTime(client,{origin:options.origin,from,to})).rows);
  } else {
    const batch = await collectProfileEntries(client,{
      origin:options.origin,
      fromEntry:options.fromEntry ?? 1,
      cursor:options.cursor,
      maxPages:options.maxPages,
    });
    rows.push(...batch.rows);
  }
  return rows;
}
