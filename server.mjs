import { createServer } from 'node:http';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const webDemo = process.argv.includes('--web-demo');
const demo = webDemo || process.argv.includes('--demo');
const databaseFile = demo ? ':memory:' : process.env.TENNIS_DB || 'data/tennis.sqlite';
if (databaseFile !== ':memory:') mkdirSync(dirname(databaseFile), { recursive: true });
const db = new DatabaseSync(databaseFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS coaches (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL, lead INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, note TEXT NOT NULL,
    coach_id INTEGER NOT NULL REFERENCES coaches(id)
  );
  CREATE TABLE IF NOT EXISTS course_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  INSERT OR IGNORE INTO course_types VALUES (1,'一对一'), (2,'一对二'), (3,'团课'), (4,'对抗');
  CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, units INTEGER NOT NULL, cents INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, course_id INTEGER NOT NULL REFERENCES course_types(id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, coach_id INTEGER NOT NULL REFERENCES coaches(id), expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
    coach_id INTEGER NOT NULL REFERENCES coaches(id), kind TEXT NOT NULL, date TEXT NOT NULL,
    label TEXT NOT NULL, units INTEGER NOT NULL, cents INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL, voided INTEGER NOT NULL DEFAULT 0, course TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS ledger_student ON ledger(student_id);
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY, coach_id INTEGER NOT NULL REFERENCES coaches(id),
    time TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requests (
    coach_id INTEGER NOT NULL REFERENCES coaches(id), key TEXT NOT NULL, PRIMARY KEY (coach_id, key)
  );
  CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), threshold INTEGER NOT NULL);
  INSERT OR IGNORE INTO settings VALUES (1, 1);
`);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function field(value, label, max, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(label + '格式有误');
  return value.trim();
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(label + '格式有误');
  return value;
}
function dateField(value, hasTime) {
  const pattern = hasTime ? /^\d{4}-\d\d-\d\dT\d\d:\d\d$/ : /^\d{4}-\d\d-\d\d$/;
  if (typeof value !== 'string' || !pattern.test(value)) fail('请填写有效日期');
  const parsed = new Date(value + (hasTime ? ':00Z' : 'T00:00:00Z'));
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, value.length) !== value) fail('请填写有效日期');
  return value;
}
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
function checkPassword(password, hash) {
  const calculated = hashPassword(password, hash.split(':')[0]);
  return timingSafeEqual(Buffer.from(calculated), Buffer.from(hash));
}
const tokenHash = token => createHash('sha256').update(token).digest('hex');
function usernameField(value) {
  const username = field(value, '账号', 32).toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) fail('账号需为 3–32 位字母、数字或 ._-');
  return username;
}
function passwordField(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) fail('密码需为 10–128 个字符');
  return value;
}
function addCoach(name, username, password, lead) {
  if (one('SELECT id FROM coaches WHERE username = ?', username)) fail('该账号已存在', 409);
  run('INSERT INTO coaches (name, username, password, lead) VALUES (?, ?, ?, ?)', name, username, hashPassword(password), lead);
}
if (!one('SELECT id FROM coaches LIMIT 1')) {
  transaction(() => {
    if (one('SELECT id FROM coaches LIMIT 1')) return;
    const name = demo ? '林教练' : field(process.env.TENNIS_ADMIN_NAME || '负责人教练', '姓名', 50);
    const username = usernameField(demo ? 'coach' : process.env.TENNIS_ADMIN_USER || 'admin');
    const password = passwordField(webDemo ? process.env.TENNIS_DEMO_PASSWORD :
      demo ? 'TennisDemo26' : process.env.TENNIS_ADMIN_PASSWORD);
    addCoach(name, username, password, 1);
    if (!demo) return;
    addCoach('周教练', 'zhou', password, 0);
    run("INSERT INTO prices (name,units,cents,course_id) VALUES ('私教体验课',1,28000,1), ('私教 10 节课包',10,240000,1), ('团课 8 节课包',8,96000,3)");
    for (const [index, name, coach, bought, used] of [[1,'陈小满',1,10,9],[2,'许一诺',1,8,3],[3,'李嘉言',2,1,1],[4,'赵雨桐',2,10,2]]) {
      run('INSERT INTO students VALUES (?,?,?,?,?)', index, name, '', '演示档案', coach);
      run("INSERT INTO ledger (student_id,coach_id,kind,date,label,units,cents,note) VALUES (?,?,'payment','2026-11-01','演示课包',?,?,'')", index, coach, bought, bought * 12000);
      run("INSERT INTO ledger (student_id,coach_id,kind,date,label,units,note) VALUES (?,?,'lesson','2026-11-08T15:30','到课',?,'演示补录')", index, coach, -used);
    }
  });
}

const balance = id => one('SELECT COALESCE(SUM(units), 0) AS units FROM ledger WHERE student_id = ? AND voided = 0', id).units;
function studentFor(id, actor) {
  const student = one('SELECT * FROM students WHERE id = ? AND (? OR coach_id = ?)', id, actor.lead, actor.id);
  if (!student) fail('学员不存在或无权访问', 404);
  return student;
}
function coachFor(id) {
  if (!one('SELECT id FROM coaches WHERE id = ? AND active = 1', id)) fail('请选择有效的教练');
  return id;
}
function requireLead(actor) {
  if (!actor.lead) fail('此操作需要负责人权限', 403);
}
function courseFor(id) {
  const course = one('SELECT * FROM course_types WHERE id = ?', id);
  if (!course) fail('请选择课程类型');
  return course;
}
function audit(actor, action, detail) {
  run('INSERT INTO audit (coach_id,time,action,detail) VALUES (?,?,?,?)', actor.id, new Date().toISOString(), action, detail);
}
function snapshot(actor) {
  return {
    actor,
    demo,
    threshold: one('SELECT threshold FROM settings WHERE id = 1').threshold,
    coaches: actor.lead
      ? all('SELECT id,name,username,lead,active FROM coaches ORDER BY id')
      : all('SELECT id,name,active FROM coaches ORDER BY id'),
    students: all(`SELECT s.*, COALESCE(SUM(l.units), 0) AS balance,
      COUNT(CASE WHEN l.kind = 'payment' THEN 1 END) AS payments
      FROM students s LEFT JOIN ledger l ON s.id = l.student_id AND l.voided = 0
      WHERE ? OR s.coach_id = ? GROUP BY s.id ORDER BY s.name`, actor.lead, actor.id),
    ledger: all(`SELECT l.* FROM ledger l JOIN students s ON l.student_id = s.id
      WHERE ? OR s.coach_id = ? ORDER BY l.date DESC, l.id DESC`, actor.lead, actor.id),
    prices: all('SELECT * FROM prices WHERE active = 1 OR ? ORDER BY id', actor.lead),
    courses: all('SELECT * FROM course_types ORDER BY id'),
    audit: actor.lead ? all(`SELECT a.*, c.name AS coach FROM audit a
      JOIN coaches c ON c.id = a.coach_id ORDER BY a.id DESC LIMIT 100`) : []
  };
}
function mutate(actor, body) {
  switch (body.action) {
    case 'student': {
      const name = field(body.name, '姓名', 50);
      const phone = field(body.phone, '联系方式', 50, false);
      const note = field(body.note, '备注', 500, false);
      const existing = body.id ? studentFor(body.id, actor) : null;
      const coach = !actor.lead ? actor.id :
        existing?.coach_id === body.coach_id ? existing.coach_id : coachFor(body.coach_id);
      if (existing) run('UPDATE students SET name=?,phone=?,note=?,coach_id=? WHERE id=?', name, phone, note, coach, existing.id);
      else run('INSERT INTO students (name,phone,note,coach_id) VALUES (?,?,?,?)', name, phone, note, coach);
      return;
    }
    case 'lesson': {
      const date = dateField(body.date, true);
      const note = field(body.note, '备注', 500, false);
      const coach = actor.lead ? coachFor(body.coach_id) : actor.id;
      const course = courseFor(body.course_id);
      if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 100) fail('请选择 1–100 位学员');
      const seen = new Set();
      for (const entry of body.entries) {
        if (!entry || typeof entry !== 'object') fail('学员出勤格式有误');
        const id = integer(entry.id, 1, Number.MAX_SAFE_INTEGER, '学员');
        if (seen.has(id)) fail('同一学员只能登记一次');
        seen.add(id);
        const student = studentFor(id, actor);
        if (!['到课', '请假', '取消', '缺席'].includes(entry.status)) fail('请选择出勤状态');
        const min = entry.status === '到课' ? 1 : 0;
        const max = ['请假', '取消'].includes(entry.status) ? 0 : 100;
        const units = integer(entry.units, min, max, '扣课节数');
        if (units > balance(id)) fail(student.name + '的剩余课时不足，请先登记购课', 409);
        run(`INSERT INTO ledger (student_id,coach_id,kind,date,label,units,note,course)
          VALUES (?,?,'lesson',?,?,?,?,?)`, id, coach, date, entry.status, -units, note, course.name);
        audit(actor, '登记上课', student.name + ' · ' + entry.status + ' · 扣 ' + units + ' 节');
      }
      return;
    }
    case 'payment': {
      const student = studentFor(body.student_id, actor);
      const price = one('SELECT * FROM prices WHERE id = ? AND active = 1', body.price_id);
      if (!price) fail('请选择有效的课包');
      const date = dateField(body.date, false);
      const cents = integer(body.cents, 0, 100000000, '实收金额');
      const units = integer(body.units, 1, 10000, '购课节数');
      const note = field(body.note, '备注', 500, false);
      run(`INSERT INTO ledger (student_id,coach_id,kind,date,label,units,cents,note,course)
        VALUES (?,?,'payment',?,?,?,?,?,?)`, student.id, actor.id, date, price.name, units, cents, note, courseFor(price.course_id).name);
      audit(actor, '登记缴费', student.name + ' · ' + price.name + ' · ' + units + ' 节 · ¥' + (cents / 100).toFixed(2));
      return;
    }
    case 'void': {
      requireLead(actor);
      const row = one('SELECT * FROM ledger WHERE id = ? AND voided = 0', body.id);
      if (!row) fail('记录已作废或不存在', 404);
      const student = studentFor(row.student_id, actor);
      const reason = field(body.reason, '更正原因', 200);
      if (balance(student.id) - row.units < 0) fail('作废后课时会变为负数，请先更正相关扣课记录', 409);
      run('UPDATE ledger SET voided = 1 WHERE id = ?', row.id);
      audit(actor, '作废' + (row.kind === 'lesson' ? '上课记录' : '缴费记录'), student.name + ' · 记录 #' + row.id + ' · ' + reason);
      return;
    }
    case 'price': {
      requireLead(actor);
      const name = field(body.name, '课包名称', 50);
      const units = integer(body.units, 1, 10000, '课包节数');
      const cents = integer(body.cents, 0, 100000000, '课包价格');
      const course = courseFor(body.course_id);
      if (body.id) {
        if (!one('SELECT id FROM prices WHERE id = ?', body.id)) fail('课包不存在', 404);
        run('UPDATE prices SET name=?,units=?,cents=?,active=?,course_id=? WHERE id=?', name, units, cents, body.active ? 1 : 0, course.id, body.id);
      } else {
        run('INSERT INTO prices (name,units,cents,course_id) VALUES (?,?,?,?)', name, units, cents, course.id);
      }
      return;
    }
    case 'course': {
      requireLead(actor);
      const name = field(body.name, '课程类型名称', 50);
      if (body.id) courseFor(body.id);
      if (one('SELECT id FROM course_types WHERE name = ? AND id <> ?', name, body.id || 0)) fail('该课程类型已存在', 409);
      if (body.id) run('UPDATE course_types SET name=? WHERE id=?', name, body.id);
      else run('INSERT INTO course_types (name) VALUES (?)', name);
      return;
    }
    case 'coach': {
      requireLead(actor);
      const name = field(body.name, '教练姓名', 50);
      if (!body.id) {
        addCoach(name, usernameField(body.username), passwordField(body.password), 0);
        audit(actor, '新增教练', name);
        return;
      }
      const target = one('SELECT * FROM coaches WHERE id=?', body.id);
      if (!target) fail('教练不存在', 404);
      if (target.lead && !body.active) fail('负责人账号必须启用');
      const password = body.password ? hashPassword(passwordField(body.password)) : target.password;
      run('UPDATE coaches SET name=?,password=?,active=? WHERE id=?', name, password, body.active ? 1 : 0, target.id);
      if (body.password || !body.active) run('DELETE FROM sessions WHERE coach_id=?', target.id);
      audit(actor, '更新教练账号', name);
      return;
    }
    case 'threshold':
      requireLead(actor);
      run('UPDATE settings SET threshold = ? WHERE id = 1', integer(body.threshold, 0, 100, '提醒门槛'));
      return;
    default:
      fail('未知操作', 404);
  }
}

const attempts = new Map();
async function payload(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('需要 JSON 请求', 415);
  let content = '';
  for await (const chunk of req.setEncoding('utf8')) {
    content += chunk;
    if (content.length > 65536) fail('请求过大', 413);
  }
  let body;
  try { body = JSON.parse(content); } catch { fail('请求格式无效'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('请求格式无效');
  return body;
}
const publicFiles = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']]
]);
const origins = new Set(['capacitor://localhost', 'https://localhost']);
export async function handleRequest(req, res) {
  const send = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && publicFiles.has(path)) {
      const [file, type] = publicFiles.get(path);
      const content = readFileSync(new URL('public/' + file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(content);
      return;
    }
    if (!path.startsWith('/api/')) fail('页面不存在', 404);
    if (origins.has(req.headers.origin)) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (path === '/api/login' && req.method === 'POST') {
      const body = await payload(req);
      const username = usernameField(body.username);
      const password = passwordField(body.password);
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
      const key = req.socket.remoteAddress + '|' + username;
      const attempt = attempts.get(key) || { count: 0, until: now + 600000 };
      if (attempt.count >= 8) fail('尝试次数过多，请稍后再试', 429);
      const coach = one('SELECT * FROM coaches WHERE username=? AND active=1', username);
      if (!coach || !checkPassword(password, coach.password)) {
        attempt.count++;
        attempts.set(key, attempt);
        fail('账号或密码有误', 401);
      }
      attempts.delete(key);
      const token = randomBytes(32).toString('hex');
      run('DELETE FROM sessions WHERE expires <= ?', now);
      run('INSERT INTO sessions VALUES (?,?,?)', tokenHash(token), coach.id, now + 12 * 3600000);
      send(200, { token });
      return;
    }
    const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) fail('请先登录', 401);
    const hash = tokenHash(token);
    const actor = one(`SELECT c.id,c.name,c.username,c.lead FROM sessions s JOIN coaches c ON c.id=s.coach_id
      WHERE s.token=? AND s.expires>? AND c.active=1`, hash, Date.now());
    if (!actor) fail('登录已失效，请重新登录', 401);
    if (path === '/api/state' && req.method === 'GET') {
      send(200, snapshot(actor));
    } else if (path === '/api/logout' && req.method === 'POST') {
      run('DELETE FROM sessions WHERE token = ?', hash);
      send(200, {});
    } else if (path === '/api/change' && req.method === 'POST') {
      const body = await payload(req);
      const key = field(body.key, '请求编号', 100);
      transaction(() => {
        const current = one(`SELECT c.id,c.name,c.username,c.lead FROM sessions s JOIN coaches c ON c.id=s.coach_id
          WHERE s.token=? AND s.expires>? AND c.active=1`, hash, Date.now());
        if (!current) fail('登录已失效，请重新登录', 401);
        if (run('INSERT OR IGNORE INTO requests VALUES (?,?)', current.id, key).changes) mutate(current, body);
      });
      send(200, snapshot(actor));
    } else {
      fail('接口不存在', 404);
    }
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : '服务暂时无法处理，请稍后重试' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer(handleRequest);
  const localDemo = demo && !webDemo;
  const host = localDemo ? '127.0.0.1' : process.env.TENNIS_HOST || '127.0.0.1';
  const port = process.env.TENNIS_PORT || (localDemo ? undefined : process.env.PORT) || 4173;
  server.listen(Number(port), host, () => {
    console.log('网球课记' + (demo ? '（演示）' : '') + ' http://' + host + ':' + server.address().port);
  });
}
