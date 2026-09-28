#!/usr/bin/env node
/**
 * Data model reference (mobile/docs/data-model/): the schema is derived, the
 * meaning is written by hand, and the two are checked against each other.
 *
 *   - schema.json      generated: user.db as the real migrations build it
 *                      (schema-columns.mjs shim), plus the downloadable
 *                      checklist modules read from dist/datasets/ when present
 *                      (otherwise the previous snapshot is kept);
 *   - semantics.md     hand-written, bilingual: domains, one line per table,
 *                      column notes, logical references (no FOREIGN KEY),
 *                      invariants, UML (mermaid), audit findings;
 *   - data-model.html  generated page (template.html + both of the above),
 *                      published as an artifact.
 *
 *   node scripts/gen-data-model.mjs           # write schema.json + data-model.html
 *   node scripts/gen-data-model.mjs --check   # exit 1 if either is stale, or the
 *                                             # semantics name a table / column
 *                                             # that does not exist, or a table
 *                                             # has no domain or description
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';
import { LATEST_SCHEMA_VERSION } from '../src/db/migrations.ts';
import { migratedDb } from './schema-columns.mjs';

const DIR = '../docs/data-model';
const SCHEMA = `${DIR}/schema.json`;
const SEMANTICS = `${DIR}/semantics.md`;
const TEMPLATE = `${DIR}/template.html`;
const PAGE = `${DIR}/data-model.html`;
const DIST = '../../dist/datasets';
const MODULES = ['tw-taicol', 'jp-ylist', 'tw-keys'];

// ── schema ───────────────────────────────────────────────────────────────────

/** The CHECK (...) clauses of a CREATE TABLE statement, parentheses balanced. */
function checksOf(sql) {
  const out = [];
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(sql ?? ''))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < sql.length && depth; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
    }
    out.push(sql.slice(m.index + m[0].length, i - 1).replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** Top-level comma split of `a, IFNULL(b, ''), c`. */
function splitTop(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Column list of a CREATE INDEX statement, expressions kept as written; null for autoindexes. */
function indexColumns(def) {
  const m = /\bON\s+\S+\s*\(/i.exec(def);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < def.length && depth; i++) {
    if (def[i] === '(') depth++;
    else if (def[i] === ')') depth--;
  }
  return splitTop(def.slice(start, i - 1).replace(/\s+/g, ' '));
}

function describeDb(db) {
  const tables = {};
  const names = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all();
  for (const { name, sql } of names) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => ({
      name: c.name,
      type: c.type || null,
      notnull: !!c.notnull,
      default: c.dflt_value ?? null,
      pk: c.pk || 0,
    }));
    const fks = db.prepare(`PRAGMA foreign_key_list("${name}")`).all().map((f) => ({
      from: f.from,
      table: f.table,
      to: f.to ?? null,
      on_delete: f.on_delete,
    }));
    const indexes = db
      .prepare(`PRAGMA index_list("${name}")`)
      .all()
      .filter((i) => i.origin !== 'pk')
      .map((i) => {
        const def = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(i.name)?.sql ?? '';
        return {
          name: i.name,
          unique: !!i.unique,
          columns: indexColumns(def) ?? db.prepare(`PRAGMA index_info("${i.name}")`).all().map((c) => c.name),
          where: /\bWHERE\b(.*)$/is.exec(def)?.[1].replace(/\s+/g, ' ').trim() ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    tables[name] = { columns, fks, indexes, checks: checksOf(sql) };
  }
  return tables;
}

async function buildSchema(previous) {
  const db = await migratedDb();
  const user = { version: LATEST_SCHEMA_VERSION, tables: describeDb(db) };
  db.close();
  let modules = previous?.modules ?? {};
  if (existsSync(`${DIST}/manifest.json`)) {
    const manifest = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8'));
    modules = {};
    for (const id of MODULES) {
      const file = `${DIST}/${id}.db`;
      if (!existsSync(file)) continue;
      const mdb = new DatabaseSync(file, { readOnly: true });
      const entry = manifest.datasets.find((d) => d.id === id);
      modules[id] = { version: entry?.version ?? null, tables: describeDb(mdb) };
      mdb.close();
    }
  }
  return { user, modules };
}


// ── semantics ────────────────────────────────────────────────────────────────

function readSemantics() {
  const text = readFileSync(SEMANTICS, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${SEMANTICS}: missing the --- front matter ---`);
  return { meta: yaml.load(m[1]), body: m[2] };
}

/** Every identifier in the app's source, and every source file name, for checking what the diagrams name. */
function appSource() {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk('src');
  walk('app');
  const ids = new Set();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/[A-Za-z_$][\w$]*/g)) ids.add(m[0]);
  return { ids, files: new Set(files), names: new Set(files.map((f) => f.split('/').pop())) };
}

const splitAlts = (to) => to.split('|').map((x) => x.trim());

/** Everything the hand-written file claims that the schema or the source can refute. */
function validate(schema, sem, src) {
  const errors = [];
  const T = schema.user.tables;
  const has = (t, c) => !!T[t] && (c == null || T[t].columns.some((x) => x.name === c));
  const { domains, tables = {}, module_tables: modTables = {}, logical_refs: refs = [] } = sem.meta;

  const seen = new Map();
  for (const d of domains) {
    if (!d.zh || !d.en) errors.push(`domain ${d.id}: needs zh and en`);
    if (!d.tables.includes(d.root)) errors.push(`domain ${d.id}: root ${d.root} is not one of its tables`);
    for (const t of d.tables) {
      if (!T[t]) errors.push(`domain ${d.id}: table ${t} does not exist`);
      if (seen.has(t)) errors.push(`table ${t} is in two domains (${seen.get(t)}, ${d.id})`);
      seen.set(t, d.id);
    }
  }
  for (const t of Object.keys(T)) {
    if (!seen.has(t)) errors.push(`table ${t} has no domain (add it to a domain in semantics.md)`);
    if (!tables[t]?.zh || !tables[t]?.en) errors.push(`table ${t} has no zh / en description`);
  }
  for (const [t, def] of Object.entries(tables)) {
    if (!T[t]) errors.push(`tables.${t}: no such table`);
    for (const [c, note] of Object.entries(def.columns ?? {})) {
      if (!has(t, c)) errors.push(`tables.${t}.columns.${c}: no such column`);
      if (!note?.zh || !note?.en) errors.push(`tables.${t}.columns.${c}: needs zh and en`);
    }
  }
  for (const [id, mt] of Object.entries(schema.modules)) {
    for (const t of Object.keys(mt.tables)) if (!modTables[id]?.[t]?.zh || !modTables[id]?.[t]?.en) errors.push(`module ${id}: table ${t} has no zh / en description`);
    for (const t of Object.keys(modTables[id] ?? {})) if (!mt.tables[t]) errors.push(`module_tables.${id}.${t}: no such table`);
  }
  const target = (x) => {
    const mod = /^module:([\w-]+)\.(\w+)$/.exec(x);
    if (mod) return !schema.modules[mod[1]] || !!schema.modules[mod[1]].tables[mod[2]];
    const [t, c] = x.split('.');
    return has(t, c);
  };
  for (const r of refs) {
    if (!target(r.from) || r.from.startsWith('module:')) errors.push(`logical_refs: from ${r.from} does not exist`);
    for (const to of splitAlts(r.to)) if (!target(to)) errors.push(`logical_refs: ${r.from} → ${to} does not exist`);
    if (!r.zh || !r.en) errors.push(`logical_refs: ${r.from} needs zh and en`);
  }
  // Prose and diagrams: `table.column`, function() and file names must exist.
  for (const m of sem.body.matchAll(/`([a-z_]+)\.([a-z_]+)`/g)) if (T[m[1]] && !has(m[1], m[2])) errors.push(`body: \`${m[1]}.${m[2]}\` — no such column`);
  for (const m of sem.body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
    const w = m[1];
    if (/^(idx_|sqlite_)/.test(w) || T[w]) continue;
    const known = Object.values(schema.modules).some((mt) => mt.tables[w]) || Object.values(T).some((t) => t.columns.some((c) => c.name === w));
    if (!known) errors.push(`body: \`${w}\` is neither a table nor a column`);
  }
  for (const m of sem.body.matchAll(/\b([A-Za-z_$][\w$]*)\(\)/g)) if (!src.ids.has(m[1])) errors.push(`body: ${m[1]}() not found in src/ or app/`);
  for (const m of sem.body.matchAll(/\b([\w/[\]()-]+\.tsx?)\b/g)) {
    const f = m[1];
    const ok = f.includes('/') ? src.files.has(f) || [...src.files].some((x) => x.endsWith('/' + f)) : src.names.has(f);
    if (!ok) errors.push(`body: file ${f} not found`);
  }
  return errors;
}

// ── page ─────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
// Heading anchors keep CJK ideographs (U+4E00–U+9FFF) so Chinese headings get readable ids.
const slug = (s) => s.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');

/** The small Markdown subset semantics.md uses: headings, paragraphs, lists, tables, mermaid, `EN:` lines. */
function markdown(md) {
  const out = [];
  const lines = md.split('\n');
  let i = 0;
  const para = [];
  const flush = () => {
    if (!para.length) return;
    for (const l of para) out.push(l.startsWith('EN: ') ? `<p class="en">${inline(l.slice(4))}</p>` : `<p>${inline(l)}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```mermaid\s*$/.test(l)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<div class="diagram"><pre class="mermaid">${esc(body.join('\n'))}</pre></div>`);
      i++;
    } else if (/^#{2,3} /.test(l)) {
      flush();
      const level = l.startsWith('### ') ? 3 : 2;
      const text = l.replace(/^#+ /, '');
      out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      i++;
    } else if (/^- /.test(l)) {
      flush();
      const items = [];
      for (; i < lines.length && /^(- |  \S)/.test(lines[i]); i++) {
        if (lines[i].startsWith('- ')) items.push([lines[i].slice(2)]);
        else items[items.length - 1].push(lines[i].trim());
      }
      out.push(
        '<ul>' +
          items.map((it) => `<li>${it.map((x) => (x.startsWith('EN: ') ? `<span class="en">${inline(x.slice(4))}</span>` : inline(x))).join('')}</li>`).join('') +
          '</ul>',
      );
    } else if (/^\|/.test(l)) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      const [head, , ...body] = rows;
      out.push(
        `<div class="scroll"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      );
    } else if (!l.trim()) {
      flush();
      i++;
    } else {
      para.push(l);
      i++;
    }
  }
  flush();
  return out.join('\n');
}
const splitRow = (l) => l.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());

const typeWord = (t) => (t || 'ANY').split(/[\s(]/)[0].toUpperCase();
const entity = (x) => (x.startsWith('module:') ? `MOD_${x.split('.')[1]}` : x.split('.')[0]);

/** One erDiagram per domain: key columns only (full columns are in the table cards). */
function erDiagram(domain, schema, refs) {
  const T = schema.user.tables;
  const inDomain = new Set(domain.tables);
  const keyCols = new Map();
  const mark = (t, c, k) => {
    if (!T[t]) return;
    const m = keyCols.get(t) ?? new Map();
    m.set(c, [...new Set([...(m.get(c) ?? []), k])]);
    keyCols.set(t, m);
  };
  const lines = ['erDiagram'];
  const rels = [];
  for (const t of domain.tables) {
    for (const c of T[t].columns) if (c.pk) mark(t, c.name, 'PK');
    for (const c of T[t].columns) if (c.name === 'uuid') mark(t, c.name, 'UK');
    for (const f of T[t].fks) {
      mark(t, f.from, 'FK');
      rels.push(`  ${f.table} ||--o{ ${t} : "${f.from}"`);
    }
  }
  for (const r of refs) {
    const [ft, fc] = r.from.split('.');
    if (!inDomain.has(ft)) continue;
    mark(ft, fc, 'FK');
    for (const to of splitAlts(r.to)) rels.push(`  ${entity(to)} ||..o{ ${ft} : "${fc}"`);
  }
  for (const t of domain.tables) {
    const cols = [...(keyCols.get(t) ?? new Map())];
    // An entity with no key columns is drawn bare: an empty `{ }` block does not parse.
    if (!cols.length) {
      lines.push(`  ${t}`);
      continue;
    }
    lines.push(`  ${t} {`);
    for (const [c, ks] of cols) {
      const col = T[t].columns.find((x) => x.name === c);
      lines.push(`    ${typeWord(col?.type)} ${c}${ks.length ? ' ' + ks.join(', ') : ''}`);
    }
    lines.push('  }');
  }
  return [...lines, ...[...new Set(rels)]].join('\n');
}

/** Domains as boxes, edges = FKs and logical references that cross a domain boundary. */
function domainOverview(domains, schema, refs) {
  const of = new Map(domains.flatMap((d) => d.tables.map((t) => [t, d.id])));
  const edges = new Map();
  const add = (a, b, dashed) => {
    if (!a || !b || a === b) return;
    const k = `${a}|${b}|${dashed}`;
    edges.set(k, (edges.get(k) ?? 0) + 1);
  };
  for (const [t, def] of Object.entries(schema.user.tables)) for (const f of def.fks) add(of.get(t), of.get(f.table), false);
  for (const r of refs) for (const to of splitAlts(r.to)) add(of.get(r.from.split('.')[0]), to.startsWith('module:') ? 'modules' : of.get(to.split('.')[0]), true);
  const lines = ['flowchart LR'];
  for (const d of domains) lines.push(`  ${d.id}["${d.zh}<br/>${d.en}<br/>(${d.tables.length})"]`);
  lines.push('  modules[("名錄模組<br/>checklist modules")]');
  for (const [k, n] of edges) {
    const [a, b, dashed] = k.split('|');
    lines.push(dashed === 'true' ? `  ${a} -. ${n} .-> ${b}` : `  ${a} -- ${n} --> ${b}`);
  }
  return lines.join('\n');
}

function tableCard(name, def, sem, domainOf, incoming, where) {
  const doc = where === 'user' ? sem.meta.tables[name] : sem.meta.module_tables?.[where]?.[name];
  const notes = doc?.columns ?? {};
  const fkOf = new Map(def.fks.map((f) => [f.from, f]));
  const logical = new Map((sem.meta.logical_refs ?? []).filter((r) => r.from.startsWith(name + '.')).map((r) => [r.from.split('.')[1], r]));
  const rows = def.columns
    .map((c) => {
      const key = [c.pk ? 'PK' : '', fkOf.has(c.name) ? `FK → ${fkOf.get(c.name).table} (${fkOf.get(c.name).on_delete})` : '', logical.has(c.name) ? `⇢ ${logical.get(c.name).to}` : '']
        .filter(Boolean)
        .join('<br>');
      const n = notes[c.name];
      return `<tr><td><code>${esc(c.name)}</code></td><td class="type">${esc(c.type ?? '')}${c.notnull ? ' <span class="nn">NOT NULL</span>' : ''}</td><td class="type">${esc(c.default ?? '')}</td><td class="key">${key}</td><td>${n ? `${inline(n.zh)}<span class="en">${inline(n.en)}</span>` : ''}</td></tr>`;
    })
    .join('');
  const extra = [
    def.checks.length ? `<p class="meta"><b>CHECK</b> ${def.checks.map((c) => `<code>${esc(c)}</code>`).join(' · ')}</p>` : '',
    def.indexes.length ? `<p class="meta"><b>INDEX</b> ${def.indexes.map((i) => `<code>${i.unique ? 'UNIQUE ' : ''}(${esc(i.columns.join(', '))})${i.where ? ' WHERE ' + esc(i.where) : ''}</code>`).join(' · ')}</p>` : '',
    incoming.length ? `<p class="meta"><b>被參照 Referenced by</b> ${incoming.map((x) => `<code>${esc(x)}</code>`).join(' · ')}</p>` : '',
  ].join('');
  const search = [name, ...def.columns.map((c) => c.name), doc?.zh, doc?.en].join(' ').toLowerCase();
  return `<article class="card" id="t-${name}" data-search="${esc(search)}">
<header><h4><code>${esc(name)}</code></h4><span class="chip">${esc(domainOf)}</span><span class="count">${def.columns.length} cols</span></header>
<p>${inline(doc?.zh ?? '')}<span class="en">${inline(doc?.en ?? '')}</span></p>
<div class="scroll"><table class="cols"><thead><tr><th>欄位 column</th><th>型別 type</th><th>預設 default</th><th>鍵 key</th><th>說明 note</th></tr></thead><tbody>${rows}</tbody></table></div>
${extra}</article>`;
}

function buildPage(schema, sem) {
  const { domains, logical_refs: refs = [] } = sem.meta;
  const T = schema.user.tables;
  const domainOf = new Map(domains.flatMap((d) => d.tables.map((t) => [t, `${d.zh} ${d.en}`])));
  const incoming = new Map();
  const push = (t, s) => incoming.set(t, [...(incoming.get(t) ?? []), s]);
  for (const [t, def] of Object.entries(T)) for (const f of def.fks) push(f.table, `${t}.${f.from}`);
  for (const r of refs) for (const to of splitAlts(r.to)) push(to.startsWith('module:') ? to : to.split('.')[0], `${r.from} ⇢`);

  const cols = Object.values(T).reduce((n, t) => n + t.columns.length, 0);
  const fks = Object.values(T).reduce((n, t) => n + t.fks.length, 0);
  const stats = [
    ['schema', `v${schema.user.version}`],
    ['資料表 tables', Object.keys(T).length],
    ['欄位 columns', cols],
    ['外鍵 FKs', fks],
    ['邏輯參照 logical refs', refs.length],
    ['名錄模組 modules', Object.entries(schema.modules).map(([id, m]) => `${id} ${m.version ?? ''}`).join(' · ') || '—'],
  ];
  const statHtml = `<dl class="stats">${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;

  const er =
    `<h2 id="er">實體關聯圖 Entity–relationship diagrams</h2>
<p>先看領域總覽（數字為跨領域的參照數，實線 FK、虛線邏輯參照），再看各領域：只列主鍵、uuid 與參照欄，完整欄位在下方表目錄。</p>
<p class="en">The overview counts references across domains (solid: FK, dashed: logical). Each domain diagram shows keys, uuid and referencing columns only; full columns are in the table catalogue.</p>
<h3 id="er-overview">領域總覽 Domain overview</h3><div class="diagram"><pre class="mermaid">${esc(domainOverview(domains, schema, refs))}</pre></div>` +
    domains
      .map(
        (d) =>
          `<h3 id="er-${d.id}">${esc(d.zh)} ${esc(d.en)}</h3><p class="meta">根 root <code>${esc(d.root)}</code> · ${d.tables.map((t) => `<a href="#t-${t}"><code>${esc(t)}</code></a>`).join(' ')}</p><div class="diagram"><pre class="mermaid">${esc(erDiagram(d, schema, refs))}</pre></div>`,
      )
      .join('\n');

  const catalogue =
    `<h2 id="catalogue">表目錄 Table catalogue</h2>
<label class="filter" for="filter">篩選表名或欄名 Filter by table or column <input id="filter" type="search" placeholder="taxon_id, uuid, gloria…" autocomplete="off"></label>
<p class="meta" id="filter-count"></p>` +
    domains.map((d) => d.tables.map((t) => tableCard(t, T[t], sem, `${d.zh} ${d.en}`, incoming.get(t) ?? [], 'user')).join('\n')).join('\n');

  const refTable =
    `<h2 id="logical">邏輯參照 Logical references</h2><p>沒有宣告 FOREIGN KEY、由程式維持的參照。刪除或改名這些欄位時，資料庫不會擋。</p><p class="en">References kept by code, with no FOREIGN KEY: the database will not stop a delete or rename.</p>
<div class="scroll"><table><thead><tr><th>從 from</th><th>到 to</th><th>說明 note</th></tr></thead><tbody>` +
    refs.map((r) => `<tr><td><code>${esc(r.from)}</code></td><td>${splitAlts(r.to).map((x) => `<code>${esc(x)}</code>`).join('<br>')}</td><td>${inline(r.zh)}<span class="en">${inline(r.en)}</span></td></tr>`).join('') +
    '</tbody></table></div>';

  const moduleCards =
    `<h3 id="module-tables">模組資料表 Module tables</h3>` +
    Object.entries(schema.modules)
      .map(([id, m]) => Object.entries(m.tables).map(([t, def]) => tableCard(t, def, sem, `${id} ${m.version ?? ''}`, incoming.get(`module:${id}.${t}`) ?? [], id)).join('\n'))
      .join('\n');

  // Generated parts go after the first section (how to read) and after the module section.
  const sections = sem.body.split(/\n(?=## )/);
  const html = sections
    .map((sec, i) => {
      let h = markdown(sec);
      if (i === 0) h += '\n' + er + '\n' + catalogue + '\n' + refTable;
      if (/^## 名錄模組/.test(sec.trim())) h += '\n' + moduleCards;
      return h;
    })
    .join('\n');
  const toc = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map((m) => `<li><a href="#${m[1]}">${m[2]}</a></li>`).join('');
  return readFileSync(TEMPLATE, 'utf8')
    .replace('<!--STATS-->', statHtml)
    .replace('<!--TOC-->', `<ol>${toc}</ol>`)
    .replace('<!--CONTENT-->', html);
}

// ── main ─────────────────────────────────────────────────────────────────────

const check = process.argv.includes('--check');
const previous = existsSync(SCHEMA) ? JSON.parse(readFileSync(SCHEMA, 'utf8')) : null;
const schema = await buildSchema(previous);
const sem = readSemantics();
const errors = validate(schema, sem, appSource());
const schemaText = JSON.stringify(schema, null, 2) + '\n';
const page = buildPage(schema, sem);

if (check) {
  if (schemaText !== JSON.stringify(previous, null, 2) + '\n') errors.push(`${SCHEMA} is stale — the schema changed (run: npm run data-model)`);
  if (!existsSync(PAGE) || readFileSync(PAGE, 'utf8') !== page) errors.push(`${PAGE} is stale (run: npm run data-model)`);
}
if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  console.error(`\n${errors.length} data-model problem(s)`);
  process.exit(1);
}
if (!check) {
  writeFileSync(SCHEMA, schemaText);
  writeFileSync(PAGE, page);
}
console.log(`✓ data model: ${Object.keys(schema.user.tables).length} tables (schema v${schema.user.version}), ${sem.meta.logical_refs.length} logical references, semantics match the schema and the source`);
