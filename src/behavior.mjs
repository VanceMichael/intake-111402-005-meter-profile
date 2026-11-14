export function behavior(entry,state,fixture,scenario) {
if (entry.path === '/profiles/load/time') {
  const candidates = [...(fixture.cases[scenario] ?? []),...fixture.exchanges].find(route => route.path === '/profiles/load/entries' && route.query.fromEntry === '1').body.rows;
  const defaultRows = fixture.exchanges.find(route => route.path === '/profiles/load/time').body.rows;
  const rows = scenario === 'clock-fold' ? candidates : defaultRows;
  const from = Date.parse(entry.query.from), to = Date.parse(entry.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return {status:400,body:{error:'time range required'}};
  return {body:{meterEpoch:'e1',complete:true,rows:rows.filter(row => {const time = Date.parse(row.clock.local+'Z')+row.clock.deviation*60000;return time >= from && time < to;})}};
}
if (entry.path === '/profiles/load/entries' && entry.query.fromEntry && entry.query.fromEntry !== '1') {
  if (entry.query.fromEntry !== '2') return {body:{meterEpoch:'e1',rows:[],nextEntry:null}};
  return {body:{meterEpoch:'e1',rows:[{entry:2,captureVersion:'c1',clock:{local:'2026-10-25T02:45:00',deviation:-120,status:0},values:[1251]}],nextEntry:null}};
}
return null;
}
