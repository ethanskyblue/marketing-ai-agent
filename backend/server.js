require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5500'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

// ─── Rate Limit (직접 구현) ───────────────────────────────────────────────────
const requestCounts = new Map();
function rateLimit(max = 20) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    if (!requestCounts.has(ip)) requestCounts.set(ip, []);
    const ts = requestCounts.get(ip).filter(t => now - t < windowMs);
    ts.push(now);
    requestCounts.set(ip, ts);
    if (ts.length > max) return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of requestCounts.entries()) {
    const recent = ts.filter(t => now - t < 60000);
    if (recent.length === 0) requestCounts.delete(ip); else requestCounts.set(ip, recent);
  }
}, 3600000);

const apiLimiter = rateLimit(20);
const pdfLimiter = rateLimit(5);

app.use(express.json({ limit: '1mb' }));

// ─── CSV 로드 및 사전 집계 ────────────────────────────────────────────────────
let customerData = [];
let dataStats = {};
let cachedContext = {};          // ✅ 최적화①: 컨텍스트 문자열 캐시
let dashboardCache = null;       // ✅ 최적화②: 대시보드 분석 결과 캐시
let dashboardCacheDate = '';     // 날짜 기준 캐시 무효화

function loadCSVData() {
  try {
    const content = fs.readFileSync(path.join(__dirname, '../data/customers.csv'), 'utf-8');
    customerData = parse(content, { columns: true, skip_empty_lines: true, cast: true });
    const total = customerData.length;
    const churned = customerData.filter(r => r.Churned === 1).length;

    const avg = (col) => (customerData.reduce((s, r) => s + (parseFloat(r[col]) || 0), 0) / total).toFixed(1);

    const genderDist = {};
    const countryDist = {};
    const quarterDist = {};
    const ageGroups = { '20대': [], '30대': [], '40대': [], '50대+': [] };

    customerData.forEach(r => {
      genderDist[r.Gender] = (genderDist[r.Gender] || 0) + 1;
      countryDist[r.Country] = (countryDist[r.Country] || 0) + 1;
      quarterDist[r.Signup_Quarter] = (quarterDist[r.Signup_Quarter] || 0) + 1;
      const age = parseFloat(r.Age) || 0;
      if (age < 30) ageGroups['20대'].push(r.Churned);
      else if (age < 40) ageGroups['30대'].push(r.Churned);
      else if (age < 50) ageGroups['40대'].push(r.Churned);
      else ageGroups['50대+'].push(r.Churned);
    });

    const churnByAge = {};
    Object.entries(ageGroups).forEach(([k, v]) => {
      churnByAge[k] = v.length > 0
        ? ((v.reduce((s, x) => s + x, 0) / v.length) * 100).toFixed(1) + '%' : 'N/A';
    });

    const topCountries = Object.entries(countryDist).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const ltvValues = customerData.map(r => parseFloat(r.Lifetime_Value) || 0).sort((a, b) => b - a);
    const topLTVThreshold = ltvValues[Math.floor(ltvValues.length * 0.2)];

    // LTV 구간 (segment 타입용 — 사전 계산)
    const ltvBuckets = { '<500': 0, '500-1500': 0, '1500-3000': 0, '3000+': 0 };
    customerData.forEach(r => {
      const ltv = parseFloat(r.Lifetime_Value) || 0;
      if (ltv < 500) ltvBuckets['<500']++;
      else if (ltv < 1500) ltvBuckets['500-1500']++;
      else if (ltv < 3000) ltvBuckets['1500-3000']++;
      else ltvBuckets['3000+']++;
    });

    // ✅ 최적화③: churn 샘플을 3명으로 축소
    const churnedSample = customerData
      .filter(r => r.Churned === 1).slice(0, 3)
      .map(r => ({
        Age: r.Age, Gender: r.Gender, Country: r.Country,
        Login_Frequency: r.Login_Frequency,
        Cart_Abandonment_Rate: r.Cart_Abandonment_Rate,
        Email_Open_Rate: r.Email_Open_Rate,
        Lifetime_Value: r.Lifetime_Value,
        Days_Since_Last_Purchase: r.Days_Since_Last_Purchase
      }));
    const activeSample = customerData
      .filter(r => r.Churned === 0).slice(0, 3)
      .map(r => ({
        Age: r.Age, Gender: r.Gender, Country: r.Country,
        Login_Frequency: r.Login_Frequency,
        Cart_Abandonment_Rate: r.Cart_Abandonment_Rate,
        Email_Open_Rate: r.Email_Open_Rate,
        Lifetime_Value: r.Lifetime_Value,
        Days_Since_Last_Purchase: r.Days_Since_Last_Purchase
      }));

    dataStats = {
      total, churned, churnRate: ((churned / total) * 100).toFixed(1),
      avgAge: avg('Age'), avgLTV: avg('Lifetime_Value'),
      avgOrders: avg('Total_Purchases'),
      avgCartAbandonment: avg('Cart_Abandonment_Rate'),
      avgDiscount: avg('Discount_Usage_Rate'),
      avgEmailOpen: avg('Email_Open_Rate'),
      avgPaymentDiv: avg('Payment_Method_Diversity'),
      avgMobileUsage: avg('Mobile_App_Usage'),
      genderDist, topCountries, churnByAge, quarterDist,
      highValueCount: ltvValues.filter(v => v >= topLTVThreshold).length,
      topLTVThreshold: topLTVThreshold.toFixed(0),
      ltvBuckets, churnedSample, activeSample,
      columns: Object.keys(customerData[0] || {})
    };

    // ✅ 최적화①: 컨텍스트 문자열 미리 생성·캐시
    buildAndCacheContexts();
    console.log(`✅ CSV 로드 완료: ${total}개 레코드`);
  } catch (err) {
    console.error('CSV 로드 오류:', err.message);
  }
}

// ─── 컨텍스트 사전 빌드 (서버 시작 시 1회) ───────────────────────────────────
function buildAndCacheContexts() {
  const s = dataStats;

  // ✅ 최적화④: 공백/줄바꿈 최소화, 핵심 데이터만 압축 포함
  const base =
    `[고객데이터 ${s.total.toLocaleString()}명]\n` +
    `이탈률:${s.churnRate}%(${s.churned.toLocaleString()}명)|연령:${s.avgAge}세|LTV:$${s.avgLTV}|구매:${s.avgOrders}회\n` +
    `장바구니이탈:${s.avgCartAbandonment}%|할인사용:${s.avgDiscount}%|이메일오픈:${s.avgEmailOpen}%\n` +
    `모바일:${s.avgMobileUsage}%|결제다양성:${s.avgPaymentDiv}|고가치고객:${s.highValueCount.toLocaleString()}명(LTV≥$${s.topLTVThreshold})\n` +
    `성별:${Object.entries(s.genderDist).map(([k,v])=>`${k}:${v}`).join('/')}\n` +
    `국가TOP5:${s.topCountries.map(([c,n])=>`${c}(${n})`).join(',')}\n` +
    `연령대이탈률:${Object.entries(s.churnByAge).map(([k,v])=>`${k}:${v}`).join('|')}\n` +
    `가입분기:${Object.entries(s.quarterDist).map(([k,v])=>`${k}:${v}`).join('|')}`;

  const segExtra =
    `\nLTV구간:저가치<500(${s.ltvBuckets['<500']})|중(${s.ltvBuckets['500-1500']})|고(${s.ltvBuckets['1500-3000']})|최고3000+(${s.ltvBuckets['3000+']})`;

  const churnExtra =
    `\n이탈샘플3명:${JSON.stringify(s.churnedSample)}\n유지샘플3명:${JSON.stringify(s.activeSample)}`;

  const instruction =
    `\n[응답규칙]한국어 주/영어 부.핵심만 간결히(300~500자).숫자/통계 활용.실행가능 제안.이모지.끝에 후속질문 1개.`;

  cachedContext = {
    general:   base + instruction,
    segment:   base + segExtra + instruction,
    churn:     base + churnExtra + instruction,
    marketing: base + instruction
  };

  console.log(`📐 컨텍스트 캐시 완료 — general:${cachedContext.general.length}자 | churn:${cachedContext.churn.length}자`);
}

loadCSVData();

// ─── API: 채팅 ────────────────────────────────────────────────────────────────
app.post('/api/chat', apiLimiter, async (req, res) => {
  try {
    const { message, history = [], analysisType = 'general' } = req.body;

    if (!message || typeof message !== 'string')
      return res.status(400).json({ error: '메시지를 입력해주세요.' });
    if (message.length > 500)
      return res.status(400).json({ error: '메시지는 최대 500자까지 입력 가능합니다.' });
    if (!Array.isArray(history) || history.length > 20)
      return res.status(400).json({ error: '잘못된 대화 기록 형식입니다.' });

    const apiKey = (process.env.ANTHROPIC_API_KEY || '')
      .split('').filter(c => c.charCodeAt(0) > 31 && c.charCodeAt(0) < 127).join('').trim();
    if (!apiKey)
      return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });

    // ✅ 최적화①: 캐시된 컨텍스트 사용 (매 요청마다 재생성 없음)
    const systemPrompt = `당신은 마케팅 AI 에이전트입니다.\n${cachedContext[analysisType] || cachedContext.general}`;

    // ✅ 히스토리: 최근 6개, 각 500자 제한
    const recentHistory = history.slice(-6).map(h => ({
      role: h.role,
      content: String(h.content).substring(0, 500)
    }));

    const messages = [...recentHistory, { role: 'user', content: message }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      // ✅ 최적화④: max_tokens 1024 → 700
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 700, system: systemPrompt, messages })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', response.status, errData);
      if (response.status === 401) return res.status(500).json({ error: 'API 키가 유효하지 않습니다.' });
      if (response.status === 429) return res.status(429).json({ error: 'API 요청 한도 초과. 잠시 후 다시 시도해주세요.' });
      return res.status(500).json({ error: 'AI 응답 오류가 발생했습니다.' });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || '응답을 생성할 수 없습니다.';

    // 토큰 사용량 로그 (모니터링용)
    if (data.usage) {
      console.log(`🔢 토큰: input=${data.usage.input_tokens} output=${data.usage.output_tokens} type=${analysisType}`);
    }

    res.json({ reply });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

// ─── API: 대시보드 분석 (캐시 지원) ─────────────────────────────────────────
app.post('/api/dashboard', apiLimiter, async (req, res) => {
  try {
    // ✅ 최적화②: 당일 캐시가 있으면 API 호출 없이 즉시 반환
    const today = new Date().toISOString().slice(0, 10);
    if (dashboardCache && dashboardCacheDate === today) {
      console.log('📦 대시보드 캐시 히트');
      return res.json({ ...dashboardCache, cached: true });
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || '')
      .split('').filter(c => c.charCodeAt(0) > 31 && c.charCodeAt(0) < 127).join('').trim();
    if (!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });

    const s = dataStats;
    const total = s.total.toLocaleString();
    const cr = s.churnRate;
    const ltv = s.avgLTV;

    // 3개 탭 분석을 Promise.all로 병렬 호출 (순차 대신 동시 실행)
    const callClaude = async (message, type) => {
      const systemPrompt = `당신은 마케팅 AI 에이전트입니다.\n${cachedContext[type] || cachedContext.general}`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 700, system: systemPrompt,
          messages: [{ role: 'user', content: message }] })
      });
      if (!r.ok) throw new Error(`API 오류 ${r.status}`);
      const d = await r.json();
      if (d.usage) console.log(`🔢 대시보드[${type}]: input=${d.usage.input_tokens} output=${d.usage.output_tokens}`);
      return d.content?.[0]?.text || '';
    };

    const [segText, churnText, mktText] = await Promise.all([
      callClaude(`고객 세분화 분석: 총 ${total}명, 이탈률 ${cr}%, 평균LTV $${ltv}. 4개 세그먼트 특징과 마케팅 시사점을 간결히.`, 'segment'),
      callClaude(`이탈 예측 분석: 이탈률 ${cr}%, 주요변수(장바구니이탈·이메일오픈율·로그인빈도·마지막구매일), GradientBoost AUC 0.87. 이탈 위험 특징과 개입 전략을 간결히.`, 'churn'),
      callClaude(`마케팅 최적화: 이탈위험 ${Math.round(s.total*0.30).toLocaleString()}명, 평균LTV $${ltv}. 채널별 전략과 ROI를 간결히.`, 'marketing')
    ]);

    dashboardCache = { segText, churnText, mktText };
    dashboardCacheDate = today;
    res.json({ segText, churnText, mktText, cached: false });

  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: '대시보드 분석 오류: ' + err.message });
  }
});

// ─── API: 통계 ────────────────────────────────────────────────────────────────
app.get('/api/stats', apiLimiter, (req, res) => {
  if (!dataStats.total) return res.status(503).json({ error: '데이터를 로드 중입니다.' });
  res.json(dataStats);
});

// ─── API: PDF 생성 ────────────────────────────────────────────────────────────
app.post('/api/export-pdf', pdfLimiter, async (req, res) => {
  try {
    const { chatHistory = [], title = '마케팅 AI 에이전트 분석 보고서' } = req.body;
    if (!Array.isArray(chatHistory) || chatHistory.length === 0)
      return res.status(400).json({ error: '대화 내용이 없습니다.' });
    if (chatHistory.length > 50)
      return res.status(400).json({ error: '대화 기록이 너무 많습니다.' });

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="marketing-ai-report-${Date.now()}.pdf"`);
    doc.pipe(res);

    let fontAvailable = false;
    for (const fp of [
      '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
      '/usr/share/fonts/nanum/NanumGothic.ttf',
      path.join(__dirname, 'fonts/NanumGothic.ttf')
    ]) {
      if (fs.existsSync(fp)) { doc.registerFont('Korean', fp); fontAvailable = true; break; }
    }
    const useFont = (size = 12) => fontAvailable
      ? doc.font('Korean').fontSize(size)
      : doc.font('Helvetica').fontSize(size);

    doc.rect(0, 0, doc.page.width, 120).fill('#1a1a4e');
    useFont(24); doc.fillColor('#ffffff').text('Marketing AI Agent', 50, 30, { align: 'center' });
    useFont(14); doc.fillColor('#a0c4ff').text('Analysis Report', 50, 65, { align: 'center' });
    useFont(10); doc.fillColor('#cccccc').text(new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }), 50, 95, { align: 'center' });

    const boxY = 140;
    doc.rect(50, boxY, doc.page.width - 100, 90).fillAndStroke('#f0f4ff', '#3366ff');
    useFont(11); doc.fillColor('#1a1a4e')
      .text(`총 고객: ${dataStats.total?.toLocaleString()}명 | 이탈률: ${dataStats.churnRate}%`, 70, boxY + 10)
      .text(`평균 LTV: $${dataStats.avgLTV} | 평균 구매: ${dataStats.avgOrders}회`, 70, boxY + 28)
      .text(`이메일오픈: ${dataStats.avgEmailOpen}% | 장바구니이탈: ${dataStats.avgCartAbandonment}%`, 70, boxY + 46)
      .text(`고가치고객: ${dataStats.highValueCount?.toLocaleString()}명 (LTV ≥ $${dataStats.topLTVThreshold})`, 70, boxY + 64);

    doc.y = boxY + 110;
    useFont(14); doc.fillColor('#1a1a4e').text('── 분석 대화 내용 ──', { align: 'center' });
    doc.moveDown(0.5);

    chatHistory.forEach((item) => {
      if (doc.y > doc.page.height - 150) doc.addPage();
      const isUser = item.role === 'user';
      const boxX = isUser ? 50 : 60;
      const boxW = doc.page.width - 110;
      const textContent = (item.content || '').replace(/[^\x20-\x7E\uAC00-\uD7A3\u3130-\u318F]/g, '');
      const boxH = Math.max(40, Math.ceil(textContent.length / 60) * 14 + 20);
      if (doc.y + boxH > doc.page.height - 80) doc.addPage();
      doc.rect(boxX, doc.y, boxW, boxH).fill(isUser ? '#e8f0fe' : '#f0fff4');
      useFont(9); doc.fillColor(isUser ? '#1a73e8' : '#0d7a3e').text(isUser ? 'User' : 'AI Agent', boxX + 8, doc.y + 6);
      useFont(10); doc.fillColor('#333333').text(textContent, boxX + 8, doc.y + 20, { width: boxW - 16, lineGap: 2 });
      doc.y = doc.y + boxH + 8;
    });

    if (doc.y > doc.page.height - 60) doc.addPage();
    doc.rect(50, doc.page.height - 50, doc.page.width - 100, 1).fill('#cccccc');
    useFont(8); doc.fillColor('#999999').text('Generated by Marketing AI Agent | Powered by Claude AI', 50, doc.page.height - 40, { align: 'center' });
    doc.end();

  } catch (err) {
    console.error('PDF error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF 생성 중 오류가 발생했습니다.' });
  }
});

// ─── 헬스체크 ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    dataLoaded: customerData.length > 0,
    totalRecords: customerData.length,
    contextCached: Object.keys(cachedContext).length > 0,
    dashboardCached: !!dashboardCache,
    dashboardCacheDate
  });
});

// ─── 프론트엔드 서빙 ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Marketing AI Agent: http://localhost:${PORT}`);
  console.log(`📊 고객 데이터: ${customerData.length.toLocaleString()}개 레코드`);
});
