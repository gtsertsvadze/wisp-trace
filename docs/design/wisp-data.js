export const C = { bg: '#0b0d14', panel: '#11141d', line: 'rgba(236,238,246,.08)', text: '#eceef6', dim: '#b4b9cc', mute: '#8d93a8', mint: '#8ef0d2', coral: '#ff8f7a', slate: '#3a3f52' };
export const TASKS = ['Booked a restaurant','Cancelled a gym membership','Compared flight prices','Filed an expense report','Returned a parcel','Renewed car insurance','Found a dentist appointment','Bought a birthday gift','Summarised a 40-page PDF','Scheduled a vet visit','Ordered the weekly groceries','Changed a hotel booking','Requested a refund','Found a plumber for Tuesday','Paid a parking fine','Moved a subscription to annual'];
export const KINDS = { 'Booked a restaurant':'Bookings','Cancelled a gym membership':'Cancellations','Compared flight prices':'Research','Filed an expense report':'Admin','Returned a parcel':'Returns','Renewed car insurance':'Admin','Found a dentist appointment':'Bookings','Bought a birthday gift':'Shopping','Summarised a 40-page PDF':'Research','Scheduled a vet visit':'Bookings','Ordered the weekly groceries':'Shopping','Changed a hotel booking':'Travel','Requested a refund':'Returns','Found a plumber for Tuesday':'Bookings','Paid a parking fine':'Admin','Moved a subscription to annual':'Admin' };
export const MODELS = ['claude-sonnet-4.5','gpt-5','gemini-2.5-pro','qwen3-235b','claude-haiku-4.5'];
export const APPS = ['OpenClaw','Hermes','Browser Use','Lume'];
const r = n => Math.floor(Math.random() * n);
export function mkTrace(id) {
  const ok = Math.random() < 0.86, hand = !ok && Math.random() < 0.4, steps = 4 + r(18);
  const ticks = Array.from({ length: steps }, (_, i) => ({ bg: !ok && i === steps - 1 ? C.coral : Math.random() < 0.12 ? C.slate : C.mint }));
  const task = TASKS[r(TASKS.length)];
  return { id, task, kind: KINDS[task], steps, mins: 1 + r(19), cost: (0.02 + Math.random() * 0.6).toFixed(2), ok, hand, ticks, model: MODELS[r(MODELS.length)], app: APPS[r(APPS.length)], t: Date.now() - id * 1000 };
}
export function shapeTrace(f, i) {
  return { ...f, outcome: f.ok ? 'done' : f.hand ? 'handed back' : 'failed', inkColor: f.ok ? C.mint : f.hand ? C.dim : C.coral, bg: i === 0 ? 'rgba(142,240,210,.06)' : 'rgba(17,20,29,.8)', anim: i === 0 ? 'wt-in .5s cubic-bezier(.2,.7,.2,1) both' : 'none' };
}
export const AGENTS = [
  ['quietfox-7','OpenClaw','claude-sonnet-4.5',312,91,1840,11,'@mira',false],
  ['tidal-owl','Hermes','gpt-5',288,88,1702,9,'@dev_ana',false],
  ['brass-heron','Browser Use','gemini-2.5-pro',251,84,1510,4,'@kjs',false],
  ['seed-01','OpenClaw','claude-sonnet-4.5',240,90,1322,19,'Wisptrace',true],
  ['mossline','OpenClaw','claude-haiku-4.5',233,93,980,7,'@ferrous',false],
  ['paper-lantern','Lume','gpt-5',201,79,1420,2,'@leah.b',false],
  ['seed-02','Hermes','qwen3-235b',188,81,1104,19,'Wisptrace',true],
  ['northing','Browser Use','claude-sonnet-4.5',176,87,890,5,'@tomasz',false],
  ['ember-kit','OpenClaw','gemini-2.5-pro',162,76,1011,0,'@sunny',false],
  ['velloway','Hermes','gpt-5',140,85,760,3,'@jpark',false],
].map((a, i) => ({ rank: i + 1, name: a[0], app: a[1], model: a[2], tasks: a[3], rate: a[4], mins: a[5], streak: a[6], owner: a[7], seed: a[8] }));
export const MODEL_BOARD = [['claude-sonnet-4.5',1204,94,'5 min'],['gpt-5',986,91,'6 min'],['gemini-2.5-pro',742,87,'7 min'],['claude-haiku-4.5',611,83,'3 min'],['qwen3-235b',318,79,'9 min'],['llama-4-maverick',240,71,'11 min']].map((m, i) => ({ rank: i + 1, name: m[0], tasks: m[1], rate: m[2], median: m[3] }));
export const APP_BOARD = [['Hermes',9310,89,'5 min'],['OpenClaw',14020,87,'6 min'],['Browser Use',6180,82,'8 min'],['Lume',2940,78,'7 min']].map((m, i) => ({ rank: i + 1, name: m[0], tasks: m[1], rate: m[2], median: m[3] }));
export const RECIPES = [
  ['fitlane.com','Cancel a membership','trusted',23,7,'4 min','2 h ago'],
  ['fitlane.com','Pause a membership','trusted',11,5,'3 min','1 d ago'],
  ['tablehop.com','Book a table for 4','trusted',61,9,'5 min','20 min ago'],
  ['tablehop.com','Change a booking time','forming',4,6,'4 min','3 h ago'],
  ['parcelly.co','Return an item','trusted',38,8,'6 min','40 min ago'],
  ['skyfare.io','Change a flight date','outdated',0,12,'—','9 failures since 30 Oct'],
  ['streamly.tv','Cancel a subscription','trusted',52,4,'2 min','12 min ago'],
  ['cityparking.gov','Pay a parking fine','blocked',0,0,'—','site blocks agents'],
].map(x => ({ site: x[0], task: x[1], status: x[2], agents: x[3], steps: x[4], median: x[5], when: x[6] }));
export const MOVERS = [['Gift shopping',6.2,4120],['Returns & refunds',2.4,1880],['Restaurant bookings',1.6,5210],['Travel changes',1.3,2760],['Subscription cancellations',1.1,3390],['Appointment booking',0.9,2100],['Expense filing',0.7,1420],['Price comparison',0.5,980]];
export const TOP_TASKS = [['Restaurant bookings','5,210','+61%'],['Gift shopping','4,120','+520%'],['Subscription cancellations','3,390','+12%'],['Travel changes','2,760','+28%'],['Appointment booking','2,100','−9%'],['Returns & refunds','1,880','+140%']];
export const VOL14 = [61,64,70,72,58,44,47,76,81,84,88,93,70,100];
export function activityGrid(n = 182) {
  const lv = ['rgba(236,238,246,.06)','rgba(142,240,210,.25)','rgba(142,240,210,.5)','rgba(142,240,210,.75)','#8ef0d2'];
  return Array.from({ length: n }, (_, i) => { const w = Math.floor(i / 7), p = w < 4 ? 0.05 : w < 10 ? 0.3 : 0.75; const l = Math.random() > p ? 0 : 1 + Math.min(3, Math.floor(Math.random() * (w < 16 ? 2.5 : 4))); return { bg: lv[l] }; });
}
