'use strict';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const native = location.protocol === 'capacitor:' || location.origin === 'https://localhost' && Boolean(window.Capacitor);
let endpoint = native ? localStorage.getItem('tennis-server') || '' : '';
let token = sessionStorage.getItem('tennis-session') || '';
let state;
let view = 'students';
let detailId = 0;
let filterOpen = false;
let filter = { query: '', balance: '', coach: '', from: '', to: '' };
let noticeTimer;
let refreshVersion = 0;
const money = cents => '¥' + (cents / 100).toFixed(2);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const coachName = id => state.coaches.find(coach => coach.id === id)?.name || '教练';
const courseName = id => state.courses.find(course => course.id === id)?.name || '课程';
const localNow = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const dateLabel = date => date.replace('T', ' ');
const number = value => Number(value);
const brand = '<div class="brand"><span class="mark" aria-hidden="true"></span><div>网球课记<small>TENNIS LOG</small></div></div>';

function button(label, action, id = '', style = '') {
  return '<button type="button" class="btn ' + style + '" data-action="' + action + '" data-id="' + id + '">' + label + '</button>';
}
function empty(message) {
  return '<div class="empty-state">' + message + '</div>';
}
function options(items, selected) {
  return items.map(([value, name]) => '<option value="' + escape(value) + '"' +
    (String(value) === String(selected) ? ' selected' : '') + '>' + escape(name) + '</option>').join('');
}
function input(label, name, value = '', type = 'text', rules = 'required') {
  return '<label>' + label + '<input name="' + name + '" type="' + type + '" value="' + escape(value) + '" ' + rules + '></label>';
}
function select(label, name, items, selected, required = true) {
  return '<label>' + label + '<select name="' + name + '"' + (required ? ' required' : '') + '>' + options(items, selected) + '</select></label>';
}
function note(value = '', label = '备注（选填）') {
  return '<label>' + label + '<textarea name="note" maxlength="500">' + escape(value) + '</textarea></label>';
}
function announce(message) {
  notice.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.textContent = ''; }, 3500);
}
function signOut() {
  refreshVersion++;
  token = '';
  state = undefined;
  sessionStorage.removeItem('tennis-session');
  if (dialog.open) dialog.close();
  detailId = 0;
  view = 'students';
  filterOpen = false;
  filter = { query: '', balance: '', coach: '', from: '', to: '' };
  render();
}
async function api(path, body) {
  const response = await fetch(endpoint + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).catch(() => { throw new Error('无法连接服务，请检查网络和服务地址'); });
  const data = await response.json().catch(() => { throw new Error('服务返回异常'); });
  if (response.status === 401 && path !== 'login') signOut();
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}
function login() {
  app.innerHTML = '<main class="login"><div class="hero">' + brand + '<p class="eyebrow" style="margin-top:22px">教练工作台</p>' +
    '<h1>每一节课，有迹可查。</h1><p>查看学员记录，登记上课与购课。</p></div>' +
    '<form class="card stack" id="login"><h2>教练登录</h2>' +
    (native ? input('服务地址', 'endpoint', endpoint, 'url', 'required placeholder="https://你的服务域名"') : '') +
    input('账号', 'username', '', 'text', 'required autocomplete="username" autocapitalize="none"') +
    input('密码', 'password', '', 'password', 'required autocomplete="current-password"') +
    '<p class="error" role="alert"></p><button class="btn primary">登录</button></form></main>';
  app.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      if (native) {
        const url = new URL(fields.endpoint);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
          throw new Error('请输入 HTTPS 服务地址，例如 https://你的服务域名');
        }
        endpoint = url.origin;
        localStorage.setItem('tennis-server', endpoint);
      }
      const response = await api('login', { username: fields.username, password: fields.password });
      token = response.token;
      sessionStorage.setItem('tennis-session', token);
      state = await api('state');
      render();
    } catch (error) {
      form.querySelector('.error').textContent = error.message;
      announce(error.message);
    } finally {
      submit.disabled = false;
    }
  };
}
function balanceType(student) {
  if (student.balance === 0) return student.payments ? 'empty' : 'new';
  return student.balance <= state.threshold ? 'low' : 'ok';
}
function badge(student) {
  const type = balanceType(student);
  const label = { empty: '已用完', new: '待购课', low: '剩 ' + student.balance + ' 节', ok: '剩 ' + student.balance + ' 节' }[type];
  return '<span class="badge ' + type + '">' + label + '</span>';
}
function studentCard(student) {
  return '<button type="button" class="student card line" data-action="detail" data-id="' + student.id + '">' +
    '<span class="identity"><span class="avatar">' + escape(Array.from(student.name)[0]) + '</span>' +
    '<span><strong>' + escape(student.name) + '</strong><br><small>' + escape(coachName(student.coach_id)) + '</small></span></span>' +
    badge(student) + '</button>';
}
function filteredStudents() {
  const query = filter.query.trim().toLowerCase();
  const byLesson = filter.coach || filter.from || filter.to;
  const matching = byLesson ? new Set(state.ledger.filter(row => row.kind === 'lesson' && !row.voided &&
    (!filter.coach || row.coach_id === number(filter.coach)) &&
    (!filter.from || row.date.slice(0, 10) >= filter.from) &&
    (!filter.to || row.date.slice(0, 10) <= filter.to)).map(row => row.student_id)) : null;
  return state.students.filter(student => (!query || student.name.toLowerCase().includes(query) || student.phone.toLowerCase().includes(query)) &&
    (!filter.balance || balanceType(student) === filter.balance) && (!matching || matching.has(student.id)));
}
function updateList() {
  const result = filteredStudents();
  app.querySelector('#student-list').innerHTML = result.length ? result.map(studentCard).join('') : empty('没有符合条件的学员');
  app.querySelector('#count').textContent = result.length + ' 人';
}
function studentsPage() {
  const low = state.students.filter(student => balanceType(student) === 'low').length;
  const depleted = state.students.filter(student => balanceType(student) === 'empty').length;
  const stats = [['全部学员', state.students.length, ''], ['课时将尽', low, 'low'], ['课时用完', depleted, 'empty']];
  return '<section class="hero"><p class="eyebrow">学员与课时</p><h1>教练工作台</h1><p>上完课，记一笔。每位学员的课时都在这里。</p>' +
    button('＋ 登记上课', 'lesson', '', 'primary') + '</section><div class="stats">' +
    stats.map(([label, count, value]) => '<button class="stat ' + (filter.balance === value ? 'active' : '') +
      '" data-action="stat" data-id="' + value + '"><strong>' + count + '</strong><small>' + label + '</small></button>').join('') +
    '</div><div class="section-title"><div><h2>学员档案</h2><small id="count"></small></div>' +
    button('＋ 新增学员', 'student', '', 'subtle') + '</div><div class="filters">' +
    input('搜索学员', 'query', filter.query, 'search', 'placeholder="输入姓名或联系方式"') +
    '<details' + (filterOpen ? ' open' : '') + '><summary>筛选上课记录与课时</summary><div class="grid">' +
    select('授课教练', 'coach', [['', '全部'], ...state.coaches.map(coach => [coach.id, coach.name])], filter.coach, false) +
    select('课时状态', 'balance', [['', '全部'], ['low', '课时将尽'], ['empty', '课时用完'], ['ok', '课时充足'], ['new', '待购课']], filter.balance, false) +
    input('上课日期起', 'from', filter.from, 'date', '') + input('上课日期止', 'to', filter.to, 'date', '') +
    '</div></details></div><div id="student-list"></div>';
}
function historyCard(row) {
  const lesson = row.kind === 'lesson';
  const description = lesson ? '扣 ' + -row.units + ' 节' : '+' + row.units + ' 节 · ' + money(row.cents);
  return '<article class="card"><div class="line"><div><strong>' + escape(row.label) + '</strong><br><small>' +
    escape([dateLabel(row.date), row.course, coachName(row.coach_id)].filter(Boolean).join(' · ')) + '</small></div><span class="badge">' +
    (row.voided ? '已作废' : description) + '</span></div>' +
    (row.note ? '<p class="note">' + escape(row.note) + '</p>' : '') +
    (state.actor.lead && !row.voided ? '<div class="detail-actions">' + button('作废更正', 'void', row.id, 'subtle danger') + '</div>' : '') + '</article>';
}
function studentDetail(student) {
  const records = state.ledger.filter(row => row.student_id === student.id);
  return button('‹ 返回学员', 'back', '', 'subtle') + '<div class="detail"><section class="hero"><p class="eyebrow">学员档案</p><h1>' +
    escape(student.name) + '</h1><p>' + escape(coachName(student.coach_id)) + ' · 剩余 ' + student.balance + ' 节</p>' +
    (student.phone ? '<p>' + escape(student.phone) + '</p>' : '') + (student.note ? '<p class="note">' + escape(student.note) + '</p>' : '') +
    '</section><div class="detail-actions">' + button('登记上课', 'lesson', student.id, 'primary') +
    button('登记缴费', 'payment', student.id) + button('编辑档案', 'student', student.id, 'subtle') + '</div>' +
    [['lesson', '上课记录'], ['payment', '缴费记录']].map(([kind, title]) => '<section class="history"><h2 class="section-title">' + title +
      '</h2>' + (records.filter(row => row.kind === kind).map(historyCard).join('') || empty('还没有' + title)) + '</section>').join('') + '</div>';
}
function pricesPage() {
  return '<div class="section-title"><h1>课程与价格</h1>' + (state.actor.lead ? button('＋ 新增课包', 'price', '', 'primary') : '') + '</div>' +
    (state.prices.map(price => '<div class="card line"><div><strong>' + escape(price.name) + '</strong><br><small>' +
      escape(courseName(price.course_id)) + ' · ' + price.units + ' 节 · ' + money(price.cents) + (price.active ? '' : ' · 已停用') +
      '</small></div>' + (state.actor.lead ? button('编辑', 'price', price.id, 'subtle') : '') + '</div>').join('') || empty('还没有课包价格')) +
    '<div class="section-title"><h2>课程类型</h2>' + (state.actor.lead ? button('＋ 新增类型', 'course', '', 'subtle') : '') + '</div>' +
    state.courses.map(course => '<div class="card line"><strong>' + escape(course.name) + '</strong>' +
      (state.actor.lead ? button('编辑', 'course', course.id, 'subtle') : '') + '</div>').join('');
}
function settingsPage() {
  const lead = state.actor.lead;
  return '<div class="section-title"><h1>教练设置</h1>' + button('退出登录', 'logout', '', 'subtle') + '</div>' +
    '<div class="card line"><div><strong>课时提醒</strong><br><small>' + (state.threshold ? '剩余 ' + state.threshold + ' 节及以下提醒' : '课时用完时提醒') +
    '</small></div>' + (lead ? button('设置', 'threshold', '', 'subtle') : '') + '</div>' +
    (lead ? '<div class="section-title"><h2>教练账号</h2>' + button('＋ 新增教练', 'coach', '', 'subtle') + '</div>' +
      state.coaches.map(coach => '<div class="card line"><div><strong>' + escape(coach.name) + '</strong><br><small>' +
        escape(coach.username) + ' · ' + (coach.lead ? '负责人' : '普通教练') + (coach.active ? '' : ' · 已停用') + '</small></div>' +
        button('编辑', 'coach', coach.id, 'subtle') + '</div>').join('') +
      '<h2 class="section-title">最近操作记录</h2>' + (state.audit.map(item => '<article class="card"><strong>' + escape(item.action) +
        '</strong><p class="note">' + escape(item.detail) + '</p><small>' + escape(item.coach) + ' · ' +
        escape(new Date(item.time).toLocaleString('zh-CN')) + '</small></article>').join('') || empty('还没有操作记录')) : '');
}
function render() {
  if (!state) {
    login();
    return;
  }
  const student = detailId && state.students.find(item => item.id === detailId);
  const content = view === 'students' ? (student ? studentDetail(student) : studentsPage()) :
    view === 'prices' ? pricesPage() : settingsPage();
  app.innerHTML = '<header class="top"><div class="top-inner">' + brand + '<div class="profile">' + escape(state.actor.name) +
    '<br><small>' + (state.demo ? '演示模式' : state.actor.lead ? '负责人' : '教练') + '</small></div></div></header><main>' + content +
    '</main><nav class="nav" aria-label="主导航"><div class="nav-inner">' +
    [['students', '学员'], ['prices', '课程价格'], ['settings', '设置']].map(([value, title]) =>
      '<button data-action="navigate" data-id="' + value + '"' + (value === view ? ' aria-current="page"' : '') + '>' + title + '</button>').join('') +
    '</div></nav>';
  if (view === 'students' && !student) {
    updateList();
    const filters = app.querySelector('.filters');
    filters.querySelector('details').ontoggle = event => { filterOpen = event.currentTarget.open; };
    filters.addEventListener('input', event => {
      filter[event.target.name] = event.target.value;
      updateList();
      app.querySelectorAll('.stat').forEach(stat => stat.classList.toggle('active', stat.dataset.id === filter.balance));
    });
  }
}
function coachSelect(label, selected) {
  const items = state.coaches.filter(coach => coach.active || coach.id === selected).map(coach => [coach.id, coach.name + (coach.active ? '' : '（已停用）')]);
  return state.actor.lead ? select(label, 'coach_id', items, selected) : '';
}
function courseSelect(selected) {
  return select('课程类型', 'course_id', state.courses.map(course => [course.id, course.name]), selected);
}
function openForm(title, fields, build, ready) {
  dialog.innerHTML = '<div class="line"><h2 id="dialog-title">' + title + '</h2><button type="button" class="btn subtle" data-close>关闭</button></div>' +
    '<form class="stack">' + fields + '<p class="error" role="alert"></p><button class="btn primary" type="submit">保存</button></form>';
  dialog.showModal();
  const form = dialog.querySelector('form');
  let signature;
  let key;
  const close = dialog.querySelector('[data-close]');
  close.onclick = () => dialog.close();
  ready?.(form);
  form.onsubmit = async event => {
    event.preventDefault();
    const errorLabel = form.querySelector('.error');
    const submit = form.querySelector('[type="submit"]');
    errorLabel.textContent = '';
    submit.disabled = true;
    close.disabled = true;
    try {
      const data = build(Object.fromEntries(new FormData(form)), form);
      const next = JSON.stringify(data);
      if (next !== signature) {
        signature = next;
        key = crypto.randomUUID();
      }
      refreshVersion++;
      state = await api('change', { ...data, key });
      dialog.close();
      render();
      announce('已保存');
    } catch (error) {
      errorLabel.textContent = error.message;
    } finally {
      submit.disabled = false;
      close.disabled = false;
    }
  };
}
dialog.addEventListener('cancel', event => {
  if (dialog.querySelector('[type="submit"]')?.disabled) event.preventDefault();
});
function studentForm(id) {
  const student = state.students.find(item => item.id === id);
  openForm(student ? '编辑学员档案' : '新增学员', input('学员姓名', 'name', student?.name, 'text', 'required maxlength="50"') +
    input('联系方式（选填）', 'phone', student?.phone, 'tel', 'maxlength="50"') + coachSelect('负责教练', student?.coach_id || state.actor.id) +
    note(student?.note), values => ({ ...values, action: 'student', id, coach_id: number(values.coach_id) }));
}
function lessonForm(id) {
  if (!state.students.length) {
    announce('请先新增学员');
    return;
  }
  const names = state.students.map(student => '<div class="lesson-entry" data-student="' + student.id + '"><label class="pick"><input type="checkbox" name="student-' +
    student.id + '"' + (student.id === id ? ' checked' : '') + '>' + escape(student.name) + '（剩 ' + student.balance + ' 节）</label>' +
    '<div class="grid" data-fields' + (student.id === id ? '' : ' hidden') + '>' +
    select('出勤', 'status-' + student.id, ['到课', '请假', '取消', '缺席'].map(item => [item, item]), '到课') +
    input('扣课节数', 'units-' + student.id, 1, 'number', 'required min="0" max="100" step="1"') + '</div></div>').join('');
  openForm('登记上课', input('上课时间', 'date', localNow(), 'datetime-local') + courseSelect(1) +
    coachSelect('授课教练', state.actor.id) + '<div><strong>选择学员</strong><div class="choices">' + names + '</div></div>' + note(),
    values => ({
      action: 'lesson', date: values.date, note: values.note, course_id: number(values.course_id), coach_id: number(values.coach_id),
      entries: state.students.filter(student => values['student-' + student.id]).map(student => ({
        id: student.id, status: values['status-' + student.id], units: number(values['units-' + student.id] ?? 0)
      }))
    }), form => {
      for (const row of form.querySelectorAll('.lesson-entry')) {
        const checked = row.querySelector('[type="checkbox"]');
        const fields = row.querySelector('[data-fields]');
        const status = fields.querySelector('select');
        const units = fields.querySelector('input');
        const update = () => {
          fields.hidden = !checked.checked;
          status.disabled = !checked.checked;
          units.disabled = !checked.checked || ['请假', '取消'].includes(status.value);
          units.min = status.value === '到课' ? 1 : 0;
        };
        checked.onchange = update;
        status.onchange = () => {
          units.value = status.value === '到课' ? 1 : 0;
          update();
        };
        update();
      }
    });
}
function paymentForm(id) {
  const prices = state.prices.filter(price => price.active);
  if (!prices.length) {
    announce('请先由负责人新增课包价格');
    return;
  }
  const first = prices[0];
  openForm('登记缴费', select('购买课包', 'price_id', prices.map(price => [price.id, price.name + ' · ' + money(price.cents)]), first.id) +
    input('缴费日期', 'date', localNow().slice(0, 10), 'date') + '<div class="grid">' +
    input('购课节数', 'units', first.units, 'number', 'required min="1" max="10000" step="1"') +
    input('实收金额（元）', 'amount', first.cents / 100, 'number', 'required min="0" max="1000000" step="0.01"') + '</div>' + note(),
    values => ({ ...values, action: 'payment', student_id: id, price_id: number(values.price_id), units: number(values.units), cents: Math.round(number(values.amount) * 100) }),
    form => {
      form.elements.price_id.onchange = () => {
        const price = prices.find(item => item.id === number(form.elements.price_id.value));
        form.elements.units.value = price.units;
        form.elements.amount.value = price.cents / 100;
      };
    });
}
function priceForm(id) {
  const price = state.prices.find(item => item.id === id);
  openForm(price ? '编辑课包价格' : '新增课包价格', courseSelect(price?.course_id || 1) +
    input('课包名称', 'name', price?.name, 'text', 'required maxlength="50"') + '<div class="grid">' +
    input('课包节数', 'units', price?.units || 1, 'number', 'required min="1" max="10000" step="1"') +
    input('价格（元）', 'amount', price ? price.cents / 100 : '', 'number', 'required min="0" max="1000000" step="0.01"') + '</div>' +
    (price ? select('状态', 'active', [[1, '启用'], [0, '停用']], price.active) : ''),
    values => ({ ...values, action: 'price', id, course_id: number(values.course_id), units: number(values.units), cents: Math.round(number(values.amount) * 100), active: values.active !== '0' }));
}
function coachForm(id) {
  const coach = state.coaches.find(item => item.id === id);
  openForm(coach ? '编辑教练账号' : '新增教练账号',
    input('教练姓名', 'name', coach?.name, 'text', 'required maxlength="50"') +
    (coach ? '<p class="muted">账号 ' + escape(coach.username) + '</p>' : input('账号', 'username', '', 'text', 'required minlength="3" maxlength="32" autocapitalize="none"')) +
    input(coach ? '重置密码（选填）' : '初始密码', 'password', '', 'password', 'minlength="10" maxlength="128" autocomplete="new-password"' + (coach ? '' : ' required')) +
    (coach && !coach.lead ? select('账号状态', 'active', [[1, '启用'], [0, '停用']], coach.active) : ''),
    values => ({ ...values, action: 'coach', id, active: values.active !== '0' }));
}
app.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || !state) return;
  const value = target.dataset.id;
  const id = number(value);
  switch (target.dataset.action) {
    case 'navigate':
      view = value;
      detailId = 0;
      render();
      window.scrollTo(0, 0);
      break;
    case 'detail':
      detailId = id;
      render();
      window.scrollTo(0, 0);
      break;
    case 'back':
      detailId = 0;
      render();
      break;
    case 'stat':
      filter.balance = value;
      render();
      app.querySelector('#student-list').scrollIntoView({ block: 'nearest' });
      break;
    case 'student': studentForm(id); break;
    case 'lesson': lessonForm(id); break;
    case 'payment': paymentForm(id); break;
    case 'price': priceForm(id); break;
    case 'coach': coachForm(id); break;
    case 'course':
      openForm(id ? '修改课程类型名称' : '新增课程类型', input('课程类型名称', 'name', id ? courseName(id) : '', 'text', 'required maxlength="50"'),
        values => ({ ...values, action: 'course', id }));
      break;
    case 'threshold':
      openForm('设置课时提醒', input('提前提醒节数（填 0 仅提醒用完）', 'threshold', state.threshold, 'number', 'required min="0" max="100" step="1"'),
        values => ({ action: 'threshold', threshold: number(values.threshold) }));
      break;
    case 'void':
      openForm('作废记录', '<p class="muted">作废后会自动重算剩余课时，并记录更正原因。</p>' +
        input('更正原因', 'reason', '', 'text', 'required maxlength="200"'),
        values => ({ ...values, action: 'void', id }));
      break;
    case 'logout':
      try { await api('logout', {}); } catch (error) { announce(error.message); }
      signOut();
      break;
  }
});
async function refresh() {
  if (!token || dialog.open) return;
  const version = ++refreshVersion;
  try {
    const next = await api('state');
    if (version !== refreshVersion || dialog.open) return;
    state = next;
    render();
  } catch (error) {
    announce(error.message);
    if (!state) render();
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state) refresh();
});
if (token) refresh();
else render();
