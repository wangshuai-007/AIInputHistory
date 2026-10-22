const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "../src");
const statsSource = fs.readFileSync(path.join(root, "conversation-stats.js"), "utf8");
const proSource = fs.readFileSync(path.join(root, "pro-usage.js"), "utf8");

function model() {
  const context = { URL, Date, globalThis: null };
  context.globalThis = context;
  context.AIInputHistory = {};
  vm.runInNewContext(statsSource, context);
  vm.runInNewContext(proSource, context);
  return context.AIInputHistory.proUsageModel;
}

function fakeDocument(buttons) {
  const selectedButtons = buttons.filter((button) => {
    const id = button["data-testid"] || "";
    return String(button.className || "").includes("composer-pill")
      || /model-switcher|model-selector|model-picker|reasoning-effort|thinking-effort/i.test(id)
      || /^(model:|current model:|模型：)/i.test(button["aria-label"] || "");
  });
  const nodes = selectedButtons.map((button) => ({
    textContent: button.text || "",
    ...(Object.prototype.hasOwnProperty.call(button, "visibleText")
      ? { innerText: button.visibleText } : {}),
    getAttribute(name) { return button[name] || null; },
    closest() { return null; },
    getClientRects() { return button.hidden ? [] : [{}]; }
  }));
  return { querySelectorAll() { return nodes; } };
}

test("仅识别模型选择控件中明确选中的 Pro 模型，不把账户方案当模型", () => {
  const m = model();
  assert.equal(m.classifyModelLabel("GPT-6 Pro"), "gpt-6-pro");
  assert.equal(m.classifyModelLabel("GPT-5.6 Sol Pro"), "gpt-5.6-pro");
  assert.equal(m.classifyModelLabel("Pro"), "pro");
  assert.equal(m.classifyModelLabel("Pro Standard"), "pro");
  assert.equal(m.classifyModelLabel("Pro Extended"), "pro");
  assert.equal(m.classifyModelLabel("6Pro"), "gpt-6-pro");
  assert.equal(m.classifyModelLabel("5.6Pro"), "gpt-5.6-pro");
  assert.equal(m.classifyModelLabel("GPT-6 Thinking"), null);
  assert.equal(m.classifyModelLabel("GPT-6 Extra High"), null);
  assert.equal(m.classifyModelLabel("Upgrade to Pro"), null);
  assert.equal(m.classifyModelLabel("Pro subscription"), null);
  assert.equal(m.classifyModelLabel("Pro plan"), null);
  assert.equal(m.classifyModelLabel("Instant Thinking Pro"), null);
  assert.equal(m.detect(fakeDocument([{ text: "GPT-6 Pro", "data-testid": "model-switcher-dropdown-button" }])).id, "gpt-6-pro");
  assert.equal(m.detect(fakeDocument([{ text: "GPT-5.6 Sol Pro", "data-testid": "model-selector" }])).id, "gpt-5.6-pro");
  assert.equal(m.detect(fakeDocument([{ text: "GPT-6", "data-testid": "model-switcher-dropdown-button" },
    { text: "Pro", "data-testid": "reasoning-effort-selector" }])).id, "gpt-6-pro");
  assert.equal(m.detect(fakeDocument([{ text: "GPT-6 Instant", "data-testid": "model-switcher-dropdown-button" }])) , null);
  assert.equal(m.detect(fakeDocument([{ text: "Pro", hidden: true, "data-testid": "model-switcher-dropdown-button" }])) , null);
  assert.equal(m.detect(fakeDocument([{ text: "GPT-6 Pro", "data-testid": "account-badge" }])) , null);
  assert.equal(m.detect(fakeDocument([{ text: "Pro Standard", className: "__composer-pill" }])).id,
    "pro", "新版输入框右侧的 Pro 档位按钮应被识别");
  assert.equal(m.detect(fakeDocument([{ text: "6Pro", className: "__composer-pill" }])).id,
    "gpt-6-pro");
  assert.equal(m.detect(fakeDocument([{ text: "5.6Pro", className: "__composer-pill" }])).id,
    "gpt-5.6-pro");
  assert.equal(m.detect(fakeDocument([{ text: "Upgrade to Pro plan", className: "__composer-pill" }])), null);
  assert.equal(m.detect(fakeDocument([{ text: "GPT-6 Instant", className: "__composer-pill" }])), null);
});


test("按天、周、月形成连续时间线，包含空白日期和跨月本地自然周", () => {
  const m = model();
  const now = new Date(2026, 10, 3, 10, 15).getTime(); // Tue 2026-11-03
  const summary = m.summarize({
    version: 1, resetAt: new Date(2026, 9, 1).getTime(),
    models: {
      "gpt-6-pro": {
        total: 8, days: { "2026-11-03": 2, "2026-11-02": 1, "2026-10-31": 3 },
        weeks: { "2026-11-02": 3, "2026-10-26": 4 },
        months: { "2026-11": 3, "2026-10": 5 }
      },
      "gpt-5.6-pro": {
        total: 3, days: { "2026-11-03": 1, "2026-11-01": 2 },
        weeks: { "2026-11-02": 1, "2026-10-26": 2 },
        months: { "2026-11": 3 }
      }
    }
  }, now);
  assert.equal(summary.all.today, 3);
  assert.equal(summary.all.yesterday, 1);
  assert.equal(summary.all.last7Days, 9);
  assert.equal(summary.all.thisWeek, 4);
  assert.equal(summary.all.thisMonth, 6);
  assert.equal(summary.all.total, 11);
  assert.equal(summary.periods.day.length, 14);
  assert.equal(summary.periods.week.length, 8);
  assert.equal(summary.periods.month.length, 12);
  assert.equal(summary.periods.day.at(-1).key, "2026-11-03");
  assert.equal(summary.periods.day.at(-2).key, "2026-11-02");
  assert.equal(summary.periods.day.at(-1).total, 3);
  assert.equal(summary.periods.day.at(-3).total, 2);
  assert.equal(summary.periods.day.at(-4).total, 3);
  assert.equal(summary.periods.day.at(-5).total, 0);
  assert.equal(summary.periods.week.at(-1).key, "2026-11-02");
  assert.equal(summary.periods.week.at(-2).key, "2026-10-26");
  assert.equal(summary.periods.week.at(-1).total, 4);
  assert.equal(summary.periods.month.at(-1).key, "2026-11");
  assert.equal(summary.periods.month.at(-2).key, "2026-10");
  assert.equal(summary.resetAt, new Date(2026, 9, 1).getTime());
});

test("重置本地计数后自然周期为零，但日期时间线继续可读", () => {
  const m = model();
  const now = new Date(2026, 9, 20, 12).getTime();
  const clean = m.summarize({ version: 1, models: {}, requestIds: { "already-sent": { at: now - 2000 } },
    resetAt: now - 1000 }, now);
  assert.equal(clean.all.total, 0);
  assert.equal(clean.all.today, 0);
  assert.equal(clean.all.thisWeek, 0);
  assert.equal(clean.all.thisMonth, 0);
  assert.equal(clean.periods.day.at(-1).total, 0);
  assert.equal(clean.periods.week.at(-1).total, 0);
  assert.equal(clean.periods.month.at(-1).total, 0);
});
test("本机剩余估算按套餐分别应用共享与模型独立限制", () => {
  const m = model();
  const now = new Date(2026, 9, 21, 12).getTime();
  const day = "2026-10-21", week = "2026-10-19", month = "2026-10";
  const data = {
    version: 1, models: {
      "gpt-6-pro": { total: 20, days: { [day]: 8 }, weeks: { [week]: 20 }, months: { [month]: 20 } },
      "gpt-5.6-pro": { total: 12, days: { [day]: 11 }, weeks: { [week]: 12 }, months: { [month]: 12 } },
      pro: { total: 2, days: { [day]: 2 }, weeks: { [week]: 2 }, months: { [month]: 2 } }
    }
  };
  assert.equal(m.remainingEstimate({plan: "pro-100", modelId: "gpt-6-pro", stats: data, now}).remaining, 16);
  assert.equal(m.remainingEstimate({plan: "pro-100", modelId: "gpt-5.6-pro", stats: data, now}).remaining, 16);
  assert.equal(m.remainingEstimate({plan: "business-standard", modelId: "gpt-6-pro", stats: data, now}).remaining, 0);
  assert.equal(m.remainingEstimate({plan: "business-premium", modelId: "gpt-6-pro", stats: data, now}).remaining, 16);
  assert.equal(m.remainingEstimate({plan: "pro-200", modelId: "gpt-6-pro", stats: data, now}).remaining, 178);
  assert.equal(m.remainingEstimate({plan: "pro-200", modelId: "gpt-5.6-pro", stats: data, now}).remaining, 157);
  assert.equal(m.remainingEstimate({plan: "pro-200", modelId: "pro", stats: data, now}), null);
  assert.equal(m.remainingEstimate({plan: "unknown", modelId: "gpt-6-pro", stats: data, now}), null);
  assert.equal(m.remainingEstimate({plan: "enterprise", modelId: "gpt-6-pro", stats: data, now}), null);
  const mostlyDaily = {
    version: 1, models: {
      "gpt-6-pro": { total: 190, days: { [day]: 110 }, weeks: { [week]: 190 } },
      "gpt-5.6-pro": { total: 85, days: { [day]: 83 }, weeks: { [week]: 85 } }
    }
  };
  assert.equal(m.remainingEstimate({plan: "pro-200", modelId: "gpt-6-pro", stats: mostlyDaily, now}).remaining, 7,
    "Pro $200 要受到两个模型合计每日 200 次上限约束");
  assert.equal(m.remainingEstimate({plan: "pro-200", modelId: "gpt-5.6-pro", stats: mostlyDaily, now}).remaining, 7,
    "GPT-5.6 Pro 要选择每日独立及共享额度中较低的剩余值");
});

test("Pro 用量按实际本地自然周/日/月统计，并分拆 GPT-6 和 GPT-5.6", () => {
  const m = model();
  const day = new Date(2026, 9, 20, 15).getTime();
  const keys = ((at) => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    const monday = new Date(date.getTime());
    monday.setDate(monday.getDate() - (monday.getDay() || 7) + 1);
    const fmt = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
    return { day: fmt(date), week: fmt(monday), month: fmt(date).slice(0, 7) };
  })(day);
  const summary = m.summarize({
    version: 1, models: {
      "gpt-6-pro": { total: 3, days: { [keys.day]: 2 }, weeks: { [keys.week]: 2 }, months: { [keys.month]: 3 } },
      "gpt-5.6-pro": { total: 4, days: { [keys.day]: 1 }, weeks: { [keys.week]: 3 }, months: { [keys.month]: 4 } }
    }
  }, day);
  assert.deepEqual(Array.from(summary.rows, (row) => [row.id, row.total, row.today]),
    [["gpt-6-pro", 3, 2], ["gpt-5.6-pro", 4, 1]]);
  assert.equal(summary.all.total, 7);
  assert.equal(summary.all.today, 3);
  assert.equal(summary.all.thisWeek, 5);
  assert.equal(summary.all.thisMonth, 7);
  assert.equal(m.summarize(null).all.total, 0);
});


test("网页登录会话套餐读取仅提取分类，绝不返回令牌、ID 或邮箱", () => {
  const m = model();
  const secretSession = {
    accessToken: "SUPER_PRIVATE_ACCESS_TOKEN",
    user: { id: "sensitive-user-id", email: "hidden@example.test" },
    account: { planType: "pro", id: "secret-organization-id" }
  };
  const generic = m.classifyAccountPlan(secretSession);
  assert.equal(generic.plan, "pro-unverified");
  assert.equal(generic.type, "pro");
  assert.equal(generic.precise, false, "Pro 字段不足以识别 $100/$200/$500");
  assert.doesNotMatch(JSON.stringify(generic), /SECRET|sensitive|hidden@|secret-organization/);
  assert.equal(m.classifyAccountPlan({ account: { plan_type: "pro_100" } }).plan, "pro-100");
  assert.equal(m.classifyAccountPlan({ account: { planType: "pro-200" } }).plan, "pro-200");
  assert.equal(m.classifyAccountPlan({ account: { planType: "pro_500" } }).plan, "pro-500");
  assert.equal(m.classifyAccountPlan({ account: { planType: "business" } }).plan, "business-unverified");
  assert.equal(m.classifyAccountPlan({ account: { planType: "business_premium" } }).plan, "business-premium");
  assert.equal(m.classifyAccountPlan({ account: { planType: "plus" } }).plan, "plus");
  assert.equal(m.classifyAccountPlan({ account: { planType: "enterprise" } }).plan, "enterprise");
  assert.equal(m.classifyAccountPlan({ account: { planType: "future_unknown_new_tier" } }).plan, "unknown");
  assert.equal(m.classifyAccountPlan({ account: { name: "Super Pro Member" } }).plan, "unknown");
});

test("本月重置只影响月度额度，按日周计次的套餐不伪造固定月额度", () => {
  const m = model();
  const now = new Date(2026, 9, 21, 12).getTime();
  const data = { version: 1, models: {
    "gpt-6-pro": { total: 10, days: { "2026-10-21": 2 }, weeks: { "2026-10-19": 5 },
      months: { "2026-09": 4, "2026-10": 0 } },
    "gpt-5.6-pro": { total: 4, days: { "2026-10-21": 1 }, weeks: { "2026-10-19": 2 },
      months: { "2026-09": 1, "2026-10": 0 } }
  } };
  const business = m.allowanceOverview({ plan: "business-standard", stats: data, now });
  assert.equal(business.usedThisMonth, 0);
  assert.equal(business.monthlyCap, 15);
  assert.equal(business.monthlyRemaining, 15, "本月已用重置后剩余应按套餐恢复");
  const week = m.allowanceOverview({ plan: "pro-100", stats: data, now });
  assert.equal(week.monthlyCap, null, "每周配额不是固定月度配额");
  assert.equal(week.period, "week");
  assert.equal(m.remainingEstimate({ plan: "pro-100", modelId: "gpt-6-pro", stats: data, now }).remaining, 43,
    "本月重置不应暗自清空每周用量");
  const pro200 = m.allowanceOverview({ plan: "pro-200", stats: data, now });
  assert.equal(pro200.monthlyCap, null);
  assert.equal(pro200.period, "week-and-day");
  const missing = m.allowanceOverview({ plan: "pro-500", stats: data, now });
  assert.equal(missing.monthlyCap, null, "无公开定量额度时不可猜测 Pro $500");
  assert.equal(m.remainingEstimate({ plan: "pro-unverified", modelId: "pro", stats: data, now }), null);
  assert.equal(m.remainingEstimate({ plan: "pro-500", modelId: "gpt-6-pro", stats: data, now }), null);
});


test("Account lookup reads a precise session plan without exposing session tokens", async () => {
  const m = model();
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push({ url, options });
    return { ok: true, status: 200,
      async json() { return { account: { planType: "pro_200" },
        accessToken: "PRIVATE_NEVER_RETURN_THIS_TOKEN", user: { email: "secret@example.com" } }; } };
  };
  const result = await m.readCurrentAccountPlan({ fetcher });
  assert.equal(result.ok, true);
  assert.equal(result.plan, "pro-200");
  assert.equal(result.source, "chatgpt-session");
  assert.equal(seen.length, 2, "account lookup must verify active workspace even if session claims a personal plan");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret|accessToken|email/);
});

test("Account lookup falls back to the selected ChatGPT workspace without leaking OAuth tokens", async () => {
  const m = model();
  const token = "SECRET_ACCESS_TOKEN_LONG_ENOUGH_FOR_AUTH_1234";
  const routes = [];
  const fetcher = async (url, options) => {
    routes.push({ url, options });
    if (url === "/api/auth/session") return { ok: true, status: 200,
      async json() { return { accessToken: token, account: { id: "active-business-workspace" } }; }
    };
    return { ok: true, status: 200, async json() { return {
      account_ordering: ["personal", "active-business-workspace"],
      accounts: {
        personal: { account: { plan_type: "free" } },
        "active-business-workspace": { account: { plan_type: "business_standard" } }
      }
    }; } };
  };
  const result = await m.readCurrentAccountPlan({ fetcher });
  assert.equal(result.ok, true);
  assert.equal(result.plan, "business-standard");
  assert.equal(result.source, "chatgpt-account-list");
  assert.equal(routes.length, 2);
  assert.equal(routes[1].url, "/backend-api/accounts/check/v4-2023-04-27");
  assert.equal(routes[1].options.headers.Authorization, "Bearer " + token);
  assert.equal(routes[1].options.credentials, "same-origin");
  assert.doesNotMatch(JSON.stringify(result), /SECRET_ACCESS|workspace|Bearer|email/);
});

test("Account lookup preserves generic Pro when account-check denies access, and handles prolite", async () => {
  const m = model();
  const fetcher = async (url) => url === "/api/auth/session"
    ? { ok: true, status: 200, async json() { return { account: { planType: "prolite" } }; } }
    : { ok: false, status: 403 };
  const result = await m.readCurrentAccountPlan({ fetcher });
  assert.equal(result.ok, true);
  assert.equal(result.plan, "pro-unverified");
  assert.equal(result.precise, false);
});

test("Account lookup refuses to guess between multiple unmatched workspace plans", async () => {
  const m = model();
  const fetcher = async (url) => url === "/api/auth/session"
    ? { ok: true, status: 200, async json() { return { account: {} }; } }
    : { ok: true, status: 200, async json() { return { accounts: {
      a: { account: { plan_type: "free" } },
      b: { account: { plan_type: "business" } }
    } }; } };
  const result = await m.readCurrentAccountPlan({ fetcher });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "accounts-multiple-ambiguous");
});

test("Account lookup returns specific safe failure reasons for session errors", async () => {
  const m = model();
  assert.equal((await m.readCurrentAccountPlan({ fetcher: async () => ({ok:false,status:401}) })).reason,
    "session-http-401");
  assert.equal((await m.readCurrentAccountPlan({ fetcher: async () => {throw Error("secret token network failure")} })).reason,
    "session-fetch-failed");
  const fetcher = async (url) => url === "/api/auth/session"
    ? { ok:true,status:200, async json() {return {}; } }
    : { ok:false,status:403 };
  assert.equal((await m.readCurrentAccountPlan({ fetcher })).reason, "accounts-http-403");
});


test("Explicitly selected workspace ID wins over a stale personal session account ID", () => {
  const m = model();
  const list = {
    selected_account_id: "business",
    accounts: {
      personal: { account: { plan_type: "plus" } },
      business: { account: { plan_type: "business_premium" } }
    }
  };
  const result = m.classifyAccountList(list, { account: { id: "personal" } });
  assert.equal(result.plan, "business-premium");
  assert.equal(result.precise, true);
});

test("Business member API picks the CURRENT Standard seat, not a Premium teammate", async () => {
  const m = model();
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({url,init});
    const data = url === "/api/auth/session"
      ? {accessToken: "SECRET_ACCESS_TOKEN_NEVER_EXPOSE", user: {id:"user-2",email:"me@example.test"},
        account: {id: "workspace-2026"}}
      : url === "/backend-api/accounts/check/v4-2023-04-27"
        ? {selected_account_id:"workspace-2026",accounts:{
          "workspace-2026":{account:{plan_type:"business"}}}}
        : {items:[
          {id:"user-1",email:"teammate@example.test",seat_type:"premium"},
          {id:"user-2",email:"me@example.test",seat_type:"standard"}
        ], total:2};
    return {ok:true,status:200,async json(){return data}};
  };
  const result = await m.readCurrentAccountPlan({fetcher});
  assert.equal(result.plan, "business-standard");
  assert.equal(result.precise, true);
  assert.equal(result.source, "chatgpt-member-seat");
  const members = requests.find((x) => x.url.includes("/users?"));
  assert.ok(members, "should call member list only after Business detection");
  assert.ok(members.url.startsWith("/backend-api/accounts/workspace-2026/users?"));
  assert.equal(members.init.headers["ChatGPT-Account-ID"],"workspace-2026");
  assert.equal(members.init.headers.Authorization,"Bearer SECRET_ACCESS_TOKEN_NEVER_EXPOSE");
  assert.doesNotMatch(JSON.stringify(result),/user-2|workspace-2026|SECRET_|@example/);
});

test("Business Premium seat is detected from exact current member email", async () => {
  const m = model();
  const fetcher = async (url) => ({
    ok:true,status:200,async json(){
      if(url==="/api/auth/session")return {user:{email:"Me@Example.test"},account:{id:"workspace-2026"}};
      if(url==="/backend-api/accounts/check/v4-2023-04-27")return {
        accounts:{"workspace-2026":{account:{plan_type:"business"}}}
      };
      return {items:[{id:"another",email:"other@example.test",seat_type:"standard"},
        {id:"unknown-id",email:"me@example.test",seat_type:"premium"}]};
    }
  });
  const result=await m.readCurrentAccountPlan({fetcher});
  assert.equal(result.plan,"business-premium");
  assert.equal(result.source,"chatgpt-member-seat");
});

test("Business legacy default maps to Standard with a clearly marked compatibility alias", async () => {
  const m=model();
  const fetcher=async (url)=>({ok:true,status:200,async json(){
    if(url==="/api/auth/session")return {user:{id:"user-2"},account:{id:"workspace-2026"}};
    if(url==="/backend-api/accounts/check/v4-2023-04-27")
      return {accounts:{"workspace-2026":{account:{plan_type:"business"}}}};
    return {items:[{id:"user-2",seat_type:"default"}, {id:"user-1",seat_type:"premium"}]};
  }});
  const result=await m.readCurrentAccountPlan({fetcher});
  assert.equal(result.plan,"business-standard");
  assert.equal(result.precise,false,"legacy alias must not claim official precise seat confirmation");
  assert.equal(result.seatMapping,"legacy-default-as-standard");
  assert.equal(result.seatTypeCode,"default");
  assert.equal(result.source,"chatgpt-member-seat");
  assert.equal(m.classifyBusinessSeat("default"),"business-standard");
  assert.equal(m.classifyBusinessSeat("standard"),"business-standard");
  assert.equal(m.classifyBusinessSeat("premium"),"business-premium");
  assert.equal(m.classifyBusinessSeat("usage_based"),null);
});

test("Business member API errors retain generic result and expose safe reason codes", async () => {
  const m=model();
  const fetcher=async (url)=>({
    ok:!url.includes("/users?"),status:403,async json(){
      return url==="/api/auth/session" ? {user:{id:"user-2"},account:{id:"workspace-2026"}}
        : {accounts:{"workspace-2026":{account:{plan_type:"business"}}}};
    }
  });
  const result=await m.readCurrentAccountPlan({fetcher});
  assert.equal(result.plan,"business-unverified");
  assert.equal(result.seatReason,"seat-http-403");
});

test("Without current user identity, a Business member list cannot be matched safely", async () => {
  const m=model();
  let membersRead=0;
  const fetcher=async (url)=>({ok:true,status:200,async json(){
    if(url==="/api/auth/session")return {account:{id:"workspace-2026"}};
    if(url==="/backend-api/accounts/check/v4-2023-04-27")
      return {accounts:{"workspace-2026":{account:{plan_type:"business"}}}};
    membersRead++; return {items:[{id:"somebody",seat_type:"premium"}]};
  }});
  const result=await m.readCurrentAccountPlan({fetcher});
  assert.equal(result.plan,"business-unverified");
  assert.equal(result.seatReason,"seat-user-unresolved");
  assert.equal(membersRead,0,"do not fetch member list without identifying current user");
});

test("Explicitly selected Business workspace overrides stale personal Plus session", async () => {
  const m=model();
  const fetcher=async(url)=>({ok:true,status:200,async json(){
    if(url==="/api/auth/session")return {
      user:{id:"user-2"},account:{id:"personal-account",planType:"plus"}
    };
    if(url==="/backend-api/accounts/check/v4-2023-04-27")return {
      selected_account_id:"workspace-2026",accounts:{
        "personal-account":{account:{plan_type:"plus"}},
        "workspace-2026":{account:{plan_type:"business"}}
      }
    };
    return {items:[{id:"user-2",seat_type:"premium"}]};
  }});
  const result=await m.readCurrentAccountPlan({fetcher});
  assert.equal(result.plan,"business-premium");
});

test("Business member API matches only the exact user's seat, not account default", async () => {
  const m=model();
  const fetcher=async(url)=>({ok:true,status:200,async json(){
    if(url==="/api/auth/session")return {
      user:{id:"user-2"},account:{id:"workspace-2026"}
    };
    if(url==="/backend-api/accounts/check/v4-2023-04-27")return {
      accounts:{"workspace-2026":{account:{
        plan_type:"business",default_seat_type:"premium",current_user:{seat_type:"default"}
      }}
    }};
    return {items:[{id:"user-2",seat_type:"standard"}]};
  }});
  const result=await m.readCurrentAccountPlan({fetcher});
  assert.equal(result.plan,"business-standard");
});


test("Business member lookup paginates correctly when the server caps page size at 25", async () => {
  const m=model();
  const offsets=[];
  const fetcher=async(url)=>({ok:true,status:200,async json(){
    if(url==="/api/auth/session")return {
      user:{id:"user-on-second-page"},account:{id:"workspace-2026"}
    };
    if(url==="/backend-api/accounts/check/v4-2023-04-27")
      return {accounts:{"workspace-2026":{account:{plan_type:"business"}}}};
    const offset=Number(new URL(url,"https://chatgpt.com").searchParams.get("offset"));
    offsets.push(offset);
    return offset===0 ? {items:Array.from({length:25},(_,i)=>({
      id:"other-"+i,seat_type:"standard"})),limit:25,total:26}
      : {items:[{id:"user-on-second-page",seat_type:"premium"}],limit:25,total:26};
  }});
  const result=await m.readCurrentAccountPlan({fetcher});
  assert.equal(result.plan,"business-premium");
  assert.deepEqual(offsets,[0,25]);
});


test("未知 Business 席位记录安全的字段、枚举、匹配方法，不返回成员隐私数据", async () => {
  const m = model();
  const fetcher = async (url) => ({ ok: true, status: 200, async json() {
    if (url === "/api/auth/session") return {
      account: { id: "workspace-secret-id" },
      user: { id: "user-secret-id", email: "secret@example.invalid" },
      accessToken: "SECRET_BEARER_TOKEN_DO_NOT_EXPORT"
    };
    if (url === "/backend-api/accounts/check/v4-2023-04-27") return {
      accounts: { "workspace-secret-id": { account: { plan_type: "business" } } }
    };
    return { items: [
      { id: "another-user", seat_type: "premium", email: "someone@example.invalid" },
      { id: "user-secret-id", email: "secret@example.invalid", seat_type: "default",
        membership: { role: "admin" } }
    ] };
  } });
  const result = await m.readCurrentAccountPlan({ fetcher });
  assert.equal(result.plan, "business-standard");
  assert.equal(result.precise, false);
  assert.equal(result.seatMapping, "legacy-default-as-standard");
  assert.equal(result.seatField, "seat_type");
  assert.equal(result.seatTypeCode, "default");
  assert.equal(result.seatValueKind, "string");
  assert.equal(result.seatMatchedBy, "user-id");
  assert.equal(result.seatRecordCount, 2);
  assert.match(result.seatFieldKeys, /seat_type/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|user-secret|workspace-secret|@example|membership.*admin|account_user_id/i);
});

test("未知席位内容不是枚举时以安全类别代替，不输出邮箱、Token、自由文本", async () => {
  const m = model();
  const cases = [
    { seat_type: "sensitive@example.invalid", expected: "(non-enum-string)", type: "string", path: "seat_type" },
    { seat_type: { access_token: "SUPER_SECRET_TOKEN", tier: "premium" }, expected: "(object)", type: "object", path: "seat_type" },
    { membership: { role: "premium" }, expected: "(missing)", type: "missing", path: "(missing)" },
    { seatType: "custom_tier", expected: "custom_tier", type: "string", path: "seatType" },
    { seat: { type: "unknown_seat" }, expected: "unknown_seat", type: "string", path: "seat.type" }
  ];
  for (const scenario of cases) {
    const fetcher = async (url) => ({ ok: true, status: 200, async json() {
      if (url === "/api/auth/session") return {
        user: { id: "me-secret", email: "secret@example.invalid" },
        account: { id: "workspace-secret" }, accessToken: "SECRET_ACCESS_KEY"
      };
      if (url === "/backend-api/accounts/check/v4-2023-04-27") return {
        accounts: { "workspace-secret": { account: { plan_type: "business" } } }
      };
      return { items: [{ id: "me-secret", email: "secret@example.invalid", ...scenario }] };
    } });
    const result = await m.readCurrentAccountPlan({ fetcher });
    assert.equal(result.plan, "business-unverified");
    assert.equal(result.seatReason, "seat-type-unrecognized");
    assert.equal(result.seatTypeCode, scenario.expected);
    assert.equal(result.seatValueKind, scenario.type);
    assert.equal(result.seatField, scenario.path);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|@example|me-secret|workspace-secret|access_token|sensitive/i);
  }
});

test("旧版 default 作为 Standard 兼容映射，但本人明确 Premium 席位优先", async () => {
  const m = model();
  const fetcher = async (url) => ({
    ok: true, status: 200, async json() {
      if (url === "/api/auth/session") return {
        user: { id: "user-2" }, account: { id: "workspace-2026" }
      };
      if (url === "/backend-api/accounts/check/v4-2023-04-27") {
        return { accounts: { "workspace-2026": { account: {
          plan_type: "business", current_user: { seat_type: "default" },
          default_seat_type: "premium"
        } } } };
      }
      return { items: [{ id: "user-2", seat_type: "premium" }] };
    }
  });
  const result = await m.readCurrentAccountPlan({ fetcher });
  assert.equal(result.plan, "business-premium");
  assert.equal(result.precise, true);
  assert.equal(result.seatMapping, null);
  assert.equal(result.seatTypeCode, "premium");
});

test("成员接口没有直接匹配时可降级使用当前账户 default 兼容映射", async () => {
  const m = model();
  const fetcher = async (url) => ({
    ok: true, status: 200, async json() {
      if (url === "/api/auth/session") return {
        account: { id: "workspace-2026" }
      };
      if (url === "/backend-api/accounts/check/v4-2023-04-27") {
        return { accounts: { "workspace-2026": { account: {
          plan_type: "business", current_user: { seat_type: "default" }
        } } } };
      }
      throw Error("member list must not be read without a current user identity");
    }
  });
  const result = await m.readCurrentAccountPlan({ fetcher });
  assert.equal(result.plan, "business-standard");
  assert.equal(result.precise, false);
  assert.equal(result.seatMapping, "legacy-default-as-standard");
  assert.equal(result.seatTypeCode, "default");
});

test("只从当前输入框附近识别裸 Pro 按钮，不把外部套餐升级按钮计入", () => {
  const m = model();
  const makeControl = (text) => ({
    textContent: text, isConnected: true,
    getAttribute() { return null; },
    getClientRects() { return [{}]; },
    closest() { return null; }
  });
  function nearComposer(buttons, extra = []) {
    const container = { querySelectorAll() { return buttons; } };
    const editor = {
      parentElement: container, getClientRects() { return [{}]; },
      closest(selector) { return selector.includes("form") ? container : null; }
    };
    return {
      querySelectorAll(selector) {
        if (selector === m.COMPOSER_EDITOR_SELECTOR) return [editor];
        if (selector === m.SELECTORS) return extra;
        return [];
      }
    };
  }
  const pro = makeControl("Pro");
  const send = makeControl("");
  const upsell = makeControl("Upgrade to Pro plan");
  assert.equal(m.detect(nearComposer([send, pro], [upsell]))?.id, "pro");
  assert.equal(m.detect(nearComposer([send, pro]))?.evidence, "composer-pro-control");
  assert.equal(m.detect(nearComposer([send, makeControl("Pro Extended")]))?.id, "pro");
  assert.equal(m.detect(nearComposer([send, makeControl("GPT-6 Pro")]))?.id, "gpt-6-pro");
  assert.equal(m.detect(nearComposer([send, makeControl("Instant")])) , null);
  assert.equal(m.detect(nearComposer([send, makeControl("Upgrade to Pro plan")])) , null);
  assert.equal(m.detect({querySelectorAll() {return [upsell];}}), null,
    "页面其他地方独立出现 Pro 不是选择 Pro 模型的证据");
});


test("模型按钮在 form 外、但与输入框同属近邻工具栏时正确识别且远处 Pro 不误报", () => {
  const m = model();
  const makeButton = (label, x, y, menu = false) => ({
    textContent: label, isConnected: true,
    getAttribute() { return null; },
    getClientRects() { return [{}]; },
    getBoundingClientRect() {
      return { left: x, right: x + 80, top: y, bottom: y + 30, width: 80, height: 30 };
    },
    closest() { return menu ? {} : null; }
  });
  const farUpsell = makeButton("Pro", 800, 90);
  const modelChip = makeButton("Pro", 790, 1030);
  const form = { tagName: "FORM", querySelectorAll() { return []; } };
  const shell = {
    tagName: "DIV",
    querySelectorAll() { return [makeButton("Send", 980, 1030), modelChip, farUpsell]; }
  };
  form.parentElement = shell;
  const editor = {
    parentElement: form, getClientRects() { return [{}]; },
    getBoundingClientRect() {
      return { left: 300, right: 1050, top: 1000, bottom: 1080, width: 750, height: 80 };
    }
  };
  const doc = {
    querySelectorAll(query) {
      if (query === m.COMPOSER_EDITOR_SELECTOR) return [editor];
      if (query === m.SELECTORS) return [];
      return [];
    }
  };
  const result = m.detect(doc);
  assert.equal(result?.id, "pro");
  assert.equal(result?.evidence, "composer-pro-control");
  assert.equal(result?.element, modelChip);
  assert.equal(m.detectComposerModel(doc)?.element, modelChip);
  modelChip.textContent = "Thinking";
  assert.equal(m.detect(doc), null, "远处的 Pro 文案不能冒充当前选中的模型");
  modelChip.textContent = "Pro";
  modelChip.closest = () => ({});
  assert.equal(m.detect(doc), null, "未选中的隐藏菜单项目不能当作模型证据");
});


test("编辑器暂时卸载时仍可由发送/停止按钮定位同一输入区域的 Pro", () => {
  const m = model();
  const makeControl = (label) => ({
    textContent: label, isConnected: true, parentElement: null,
    getAttribute() { return null; }, getClientRects() { return [{}]; },
    closest() { return null; }
  });
  const send = makeControl("");
  const chip = makeControl("Pro");
  const shell = {
    tagName: "DIV", parentElement: null,
    querySelectorAll() { return [send, chip]; }
  };
  send.parentElement = shell;
  const doc = {
    querySelectorAll(query) {
      if (query === m.COMPOSER_EDITOR_SELECTOR) return [];
      if (query === m.COMPOSER_ACTION_SELECTOR) return [send];
      return [];
    }
  };
  assert.equal(m.detect(doc)?.id, "pro");
  chip.textContent = "Thinking";
  assert.equal(m.detect(doc), null);
  chip.textContent = "Pro";
  shell.tagName = "MAIN";
  assert.equal(m.detect(doc), null, "全页面级根节点不能作为模型识别范围");
});

test("Pro 模型按钮的 Unicode 下拉箭头属于装饰，不影响模型识别", () => {
  const m = model();
  for (const label of ["Pro⌄", "Pro▾", "Pro▼", "Pro⏷", "Pro∨", "GPT-6 Pro⌄"]) {
    assert.ok(m.classifyModelLabel(label), "模型按钮应识别: " + label);
  }
  assert.equal(m.classifyModelLabel("Pro⌄"), "pro");
  assert.equal(m.classifyModelLabel("GPT-6 Pro▼"), "gpt-6-pro");
  assert.equal(m.classifyModelLabel("Upgrade to Pro▾"), null, "套餐升级按钮不可当作模型");
  assert.equal(m.classifyModelLabel("Pro account⌄"), null, "账户徽标不可误判");
  assert.equal(m.classifyModelLabel("Thinking▾"), null, "非 Pro 模式仍应排除");
});

test("ChatGPT 真实模型按钮的隐藏 Thinking effort 测量文本不得覆盖可见 Pro", () => {
  const m = model();
  const current = fakeDocument([{
    className: "__composer-pill",
    text: "Thinking effortPro",
    visibleText: "Pro",
    "aria-label": "Select ChatGPT model"
  }]);
  assert.equal(m.detect(current)?.id, "pro",
    "按钮 textContent 包含隐藏测量文案，必须使用用户实际看见的 innerText");
  const switched = fakeDocument([{
    className: "__composer-pill",
    text: "Thinking effortInstant",
    visibleText: "Instant",
    "aria-label": "Select ChatGPT model"
  }]);
  assert.equal(m.detect(switched), null, "切到 Instant 后必须隐藏 Pro 计数");
  assert.equal(m.classifyModelLabel("Thinking effortPro"), null,
    "不能放宽模型判别器误把多模型/历史文本识别为 Pro");
});
