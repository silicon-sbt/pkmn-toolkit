#!/usr/bin/env node
// 战斗卡：开打前生成，战斗中直接照读。
//
//   node tools/battlecard.mjs teams/ou-a.txt "Swampert/Corviknight/Dragapult/Rillaboom/Rotom-Heat/Mimikyu"
//   node tools/battlecard.mjs teams/ou-a.txt teams/opp-xxx.txt
//
// 设计要点（都是实战踩出来的）：
//  1. 【先制威胁】和【免疫提醒】必须置顶 —— 先制招无视速度，免疫招打出去是 0。
//     实战中我曾说"你更快"结果被影子偷袭秒杀，就是因为它埋在分类里没看到。
//  2. 对手配置优先从 data/meta-sets.json（Smogon 真实使用率）查，不再靠猜。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseImportable, zhToEn, zhInfo, tpath } from './lib.mjs';

const args = process.argv.slice(2);
const myFile = args[0] || tpath('teams', 'ou-a.txt');
const oppArg = args[1];
if (!oppArg) { console.log('用法: node tools/battlecard.mjs <我方队伍> <对方队伍文件 或 "A/B/C">'); process.exit(1); }
const LIMIT = Number(args[2] || 6);

const { calculate, Generations, Pokemon, Move, Field } = await import('@smogon/calc');
const { Dex } = await import('@pkmn/dex');
const g = Generations.get(9);

// ---- 取对手的物种名单与（可能的）配置 ----
let oppSpecies = [];
let oppFromFile = null;
if (existsSync(oppArg)) {
  oppFromFile = parseImportable(readFileSync(oppArg, 'utf8'));
  oppSpecies = oppFromFile.map(s => s.species);
} else {
  oppSpecies = oppArg.split(/[\/、,，]+/).map(s => s.trim()).filter(Boolean);
}

// ---- 真实配置缓存 ----
let META = {};
try { META = JSON.parse(readFileSync(tpath('data', 'meta-sets.json'), 'utf8')); } catch (e) { META = {}; }

const zh = (n) => zhInfo('species', n).zh;
const norm = (n) => String(n || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
// 在缓存里按英文名/去符号名查找
function findMeta(species) {
  const en = zhToEn('species', species);
  if (META[en]) return { name: en, ...META[en] };
  const target = norm(en);
  for (const [k, v] of Object.entries(META)) if (norm(k) === target) return { name: k, ...v };
  return null;
}

const my = parseImportable(readFileSync(myFile, 'utf8'));
const opp = oppSpecies.map((sp) => {
  const en = zhToEn('species', sp);
  const fileSet = oppFromFile && oppFromFile.find(s => s.species === en);
  const meta = findMeta(en);
  if (meta) {
    return { species: en, ability: meta.ability, item: meta.item, nature: meta.nature, evs: meta.evs,
      moves: meta.moves, allMoves: meta.allMoves || [], src: 'Smogon真实使用率',
      itemPct: meta.itemPct, abilityPct: meta.abilityPct, spreadPct: meta.spreadPct };
  }
  if (fileSet) return { ...fileSet, allMoves: (fileSet.moves || []).map(m => ({ n: m, p: null })), src: '队伍文件(推测)' };
  return { species: en, level: 100, evs: {}, moves: [], allMoves: [], src: '未知(仅种族值)' };
});

const mk = (s) => new Pokemon(g, s.species, { level: 100, nature: s.nature, evs: s.evs, item: s.item, ability: s.ability });
const FIXED = ['Seismic Toss', 'Night Shade', 'Super Fang', 'Ruination'];
const atkMoves = (s) => (s.moves || []).filter(m => { const mv = Dex.moves.get(m); return mv.exists && (mv.category !== 'Status' || FIXED.includes(mv.name)); });

function best(atk, def) {
  const ap = mk(atk), dp = mk(def);
  let b = null;
  for (const name of atkMoves(atk)) {
    try {
      const r = calculate(g, ap, dp, new Move(g, name), new Field({ gameType: 'Singles' }));
      const d = Array.isArray(r.damage) ? r.damage : [r.damage, r.damage];
      const hi = Math.max(...d), lo = Math.min(...d), pct = hi / dp.stats.hp * 100;
      if (!b || pct > b.pct) {
        let ko = ''; try { ko = r.kochance().text || ''; } catch (e) { ko = lo === 0 ? '免' : ''; }
        const short = ko.includes('OHKO') ? '一确' : ko.includes('2HKO') ? '两确' : ko.includes('3HKO') ? '三确' : ko.includes('4HKO') ? '四确' : ko.includes('免疫') ? '免' : '—';
        b = { name, lo, hi, pct, short, loP: lo / dp.stats.hp * 100 };
      }
    } catch (e) {}
  }
  return b;
}
function bestWith(mvName, atk, def) {
  try {
    const r = calculate(g, mk(atk), mk(def), new Move(g, mvName), new Field({ gameType: 'Singles' }));
    const d = Array.isArray(r.damage) ? r.damage : [r.damage, r.damage];
    return { hi: Math.max(...d), pct: Math.max(...d) / mk(def).stats.hp * 100 };
  } catch (e) { return null; }
}

const L = [];
L.push('### 战斗卡');
L.push('我方: ' + my.map(p => zh(p.species)).join(' / '));
L.push('对方: ' + opp.map(o => zh(o.species)).join(' / '));

// ================= ⚠️ 先制威胁（置顶） =================
L.push('');
L.push('## ⚠️ 先制威胁  ——【先制招无视速度，你多快都会被先打】');
const prio = [];
for (const o of opp) {
  const cands = (o.allMoves && o.allMoves.length ? o.allMoves.map(m => m.n) : (o.moves || []));
  for (const mv of cands) {
    const m = Dex.moves.get(mv);
    // 只列【有伤害的】先制招。守住/看穿这类也是 +4 先制，但不是威胁。
    if (!m.exists || !(m.priority > 0) || m.category === 'Status') continue;
    // 能打我最痛的是谁
    let worst = null;
    for (const a of my) { const r = bestWith(mv, o, a); if (r && (!worst || r.pct > worst.pct)) worst = { ...r, who: zh(a.species) }; }
    const use = (o.allMoves || []).find(x => x.n === mv);
    prio.push({ opp: zh(o.species), mv, use: use && use.p, worst });
  }
}
if (prio.length) {
  prio.sort((a, b) => (b.worst ? b.worst.pct : 0) - (a.worst ? a.worst.pct : 0));
  for (const p of prio) {
    L.push('  ' + p.opp + ' 的 ' + p.mv + (p.use ? '(' + p.use + '%)' : '') +
      (p.worst ? '  -> 打你最痛: ' + p.worst.who + ' ' + p.worst.pct.toFixed(0) + '%' : ''));
  }
} else L.push('  (未识别到先制招)');

// ================= ⛔ 免疫提醒（置顶） =================
L.push('');
L.push('## ⛔ 免疫提醒  ——【这些打上去是 0 伤害，别点】');
const imm = [];
for (const a of my) {
  for (const mv of atkMoves(a)) {
    for (const o of opp) {
      const r = bestWith(mv, a, o);
      if (r && r.hi === 0) imm.push('  ' + zh(a.species) + ' 的 ' + mv + ' 对 ' + zh(o.species) + ' -> 无效');
    }
  }
}
// 特性免疫也提示
for (const o of opp) {
  const ab = o.ability || '';
  const flag = { Levitate: '飘浮：免疫地面', 'Flash Fire': '引火：火招无效且强化它', 'Water Absorb': '蓄水：水招变回血', 'Volt Absorb': '蓄电：电招变回血', 'Lightning Rod': '避雷针：电招被吸引并提升特攻', 'Storm Drain': '引水：水招被吸引并提升特攻', 'Sap Sipper': '食草：草招被吸引并提升攻击', 'Dry Skin': '干燥皮肤：水招回血', 'Good as Gold': '黄金之躯：免疫所有状态招', 'Wonder Guard': '神秘守护：非克制招无效' }[ab];
  if (flag) imm.push('  ' + zh(o.species) + ' 特性【' + ab + '】-> ' + flag);
}
if (imm.length) imm.forEach(x => L.push(x)); else L.push('  (未发现免疫项)');

// ================= A. 伤害表 =================
L.push('');
L.push('## A. 伤害表（我方最佳招 / 对面打我最痛）');
L.push('| 对手 | ' + my.map(p => zh(p.species)).join(' | ') + ' | 它打我最痛 |');
L.push('|---|' + my.map(() => '---').join('|') + '|---|');
for (const o of opp) {
  const cells = my.map(a => { const b = best(a, o); return b ? b.name + ' ' + b.loP.toFixed(0) + '-' + b.pct.toFixed(0) + '% ' + b.short : '—'; });
  let worst = null;
  for (const a of my) { const b = best(o, a); if (b && (!worst || b.pct > worst.pct)) worst = { ...b, who: zh(a.species) }; }
  L.push('| ' + zh(o.species) + ' | ' + cells.join(' | ') + ' | ' + (worst ? worst.who + ' ' + worst.name + ' ' + worst.pct.toFixed(0) + '% ' + worst.short : '—') + ' |');
}

// ================= B. 对方真实配置 =================
L.push('');
L.push('## B. 对手真实配置（来源: Smogon 使用率）');
for (const o of opp) {
  L.push('');
  L.push('### ' + zh(o.species) + '   [' + o.src + ']');
  if (o.src === 'Smogon真实使用率') {
    L.push('  道具: ' + o.item + ' (' + (o.itemPct || 0) + '%)   特性: ' + o.ability + ' (' + (o.abilityPct || 0) + '%)');
    L.push('  性格/EV: ' + o.nature + ' ' + ['hp','atk','def','spa','spd','spe'].map(k => (o.evs || {})[k] || 0).join('/') + ' (' + (o.spreadPct || 0) + '%)');
    const mv = (o.allMoves || []).slice(0, 8).map(m => m.n + '(' + m.p + '%)').join('  ');
    L.push('  招式(按使用率): ' + mv);
  } else {
    L.push('  道具: ' + (o.item || '?') + '   特性: ' + (o.ability || '?') + '   性格: ' + (o.nature || '?'));
    L.push('  招式: ' + (o.moves || []).join(' / ') || '  (未知)');
    if (o.src !== 'Smogon真实使用率') L.push('  ⚠️ 这份配置是【推测值】，不是真实数据 —— 数字仅供参考');
  }
}

L.push('');
L.push('## C. 道具破坏预警');
const DIS = { '道具破坏': ['Knock Off', 'Switcheroo', 'Trick', 'Covet', 'Thief', 'Corrosive Gas'], '异常状态': ['Toxic', 'Will-O-Wisp', 'Thunder Wave', 'Glare', 'Nuzzle', 'Sleep Powder', 'Spore', 'Hypnosis', 'Yawn'], '撒钉': ['Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web', 'Ceaseless Edge', 'Stone Axe'], '清强化': ['Haze', 'Clear Smog', 'Whirlwind', 'Roar', 'Dragon Tail', 'Circle Throw'] };
let anyDis = false;
for (const o of opp) {
  const hits = [];
  for (const [cat, list] of Object.entries(DIS)) {
    const got = (o.allMoves && o.allMoves.length ? o.allMoves.map(m => m.n) : (o.moves || [])).filter(m => list.some(x => norm(x) === norm(m)));
    if (got.length) hits.push(cat + ': ' + got.join('/'));
  }
  if (hits.length) { anyDis = true; L.push('  ' + zh(o.species)); hits.forEach(h => L.push('      ' + h)); }
}
if (!anyDis) L.push('  (未识别)');
L.push('');
L.push('## D. 我方关键道具（怕拍落/掉包）');
for (const a of my) {
  const keep = a.item && !['Heavy-Duty Boots', 'Leftovers'].includes(a.item);
  L.push('  ' + zh(a.species) + ': ' + (a.item || '无') + (keep ? '  ← 被拍落/掉包就废' : '') + (a.ability ? '  | ' + a.ability : ''));
}

const txt = L.join('\n');
writeFileSync('battlecard.md', txt, 'utf8');
console.log(txt);
