require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Trust Proxy 설정 (Cloudtype/프록시 환경 필수) ───────────────────────────
app.set('trust proxy', 1);

// ─── CORS 설정 ───────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5500'];

app.use(cors({
  origin: (origin, callback) => {
    // 개발 중 origin이 없는 경우(모바일 앱, Postman 등) 허용
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

// ─── Rate Limit 설정 ─────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,         // 1분 윈도우
  max: 20,                      // IP당 1분에 최대 20회
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
    error_en: 'Too many requests. Please try again later.'
  }
});

const pdfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'PDF 생성 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});

app.use(express.json({ limit: '1mb' }));

// ─── CSV 데이터 로드 및 전처리 ────────────────────────────────────────────────
let customerData = [];
let dataStats = {};

function loadCSVData() {
  try {
    const csvPath = path.join(__dirname, '../data/customers.csv');
    const content = fs.readFileSync(csvPath, 'utf-8');
    customerData = parse(content, {
      columns: true,
      skip_empty_lines: true,
      cast: true
    });

    // 사전 집계 통계 계산 (빠른 응답을 위해)
    const total = customerData.length;
    const churned = customerData.filter(r => r.Churned === 1).length;
    const avgAge = (customerData.reduce((s, r) => s + (parseFloat(r.Age) || 0), 0) / total).toFixed(1);
    const avgLTV = (customerData.reduce((s, r) => s + (parseFloat(r.Lifetime_Value) || 0), 0) / total).toFixed(2);
    const avgOrders = (customerData.reduce((s, r) => s + (parseFloat(r.Total_Purchases) || 0), 0) / total).toFixed(1);
    const avgCartAbandonment = (customerData.reduce((s, r) => s + (parseFloat(r.Cart_Abandonment_Rate) || 0), 0) / total).toFixed(1);
    const avgDiscount = (customerData.reduce((s, r) => s + (parseFloat(r.Discount_Usage_Rate) || 0), 0) / total).toFixed(1);
    const avgEmailOpen = (customerData.reduce((s, r) => s + (parseFloat(r.Email_Open_Rate) || 0), 0) / total).toFixed(1);

    // 성별 분포
    const genderDist = {};
    customerData.forEach(r => {
      genderDist[r.Gender] = (genderDist[r.Gender] || 0) + 1;
    });

    // 국가 분포 TOP 5
    const countryDist = {};
    customerData.forEach(r => {
      countryDist[r.Country] = (countryDist[r.Country] || 0) + 1;
    });
    const topCountries = Object.entries(countryDist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    // 이탈률 by 연령대
    const ageGroups = { '20대': [], '30대': [], '40대': [], '50대+': [] };
    customerData.forEach(r => {
      const age = parseFloat(r.Age) || 0;
      if (age < 30) ageGroups['20대'].push(r.Churned);
      else if (age < 40) ageGroups['30대'].push(r.Churned);
      else if (age < 50) ageGroups['40대'].push(r.Churned);
      else ageGroups['50대+'].push(r.Churned);
    });
    const churnByAge = {};
    Object.entries(ageGroups).forEach(([k, v]) => {
      churnByAge[k] = v.length > 0
        ? ((v.reduce((s, x) => s + x, 0) / v.length) * 100).toFixed(1) + '%'
        : 'N/A';
    });

    // 고가치 고객 (LTV 상위 20%)
    const ltvValues = customerData.map(r => parseFloat(r.Lifetime_Value) || 0).sort((a, b) => b - a);
    const topLTVThreshold = ltvValues[Math.floor(ltvValues.length * 0.2)];
    const highValueCount = ltvValues.filter(v => v >= topLTVThreshold).length;

    // 결제 방법 다양성
    const avgPaymentDiv = (customerData.reduce((s, r) => s + (parseFloat(r.Payment_Method_Diversity) || 0), 0) / total).toFixed(1);

    // 모바일 앱 사용률
    const avgMobileUsage = (customerData.reduce((s, r) => s + (parseFloat(r.Mobile_App_Usage) || 0), 0) / total).toFixed(1);

    // 가입 분기 분포
    const quarterDist = {};
    customerData.forEach(r => {
      quarterDist[r.Signup_Quarter] = (quarterDist[r.Signup_Quarter] || 0) + 1;
    });

    dataStats = {
      total,
      churned,
      churnRate: ((churned / total) * 100).toFixed(1),
      avgAge,
      avgLTV,
      avgOrders,
      avgCartAbandonment,
      avgDiscount,
      avgEmailOpen,
      genderDist,
      topCountries,
      churnByAge,
      highValueCount,
      topLTVThreshold: topLTVThreshold.toFixed(0),
      avgPaymentDiv,
      avgMobileUsage,
      quarterDist,
      columns: Object.keys(customerData[0] || {})
    };

    console.log(`✅ CSV 로드 완료: ${total}개 레코드`);
  } catch (err) {
    console.error('CSV 로드 오류:', err.message);
  }
}

loadCSVData();

// ─── Claude API 클라이언트 ────────────────────────────────────────────────────
function getAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
  return new Anthropic({ apiKey });
}

// ─── 데이터 요약 생성 (토큰 효율적) ──────────────────────────────────────────
function buildDataContext(analysisType) {
  const s = dataStats;

  // 샘플 데이터 (이탈 고객 5명 + 유지 고객 5명)
  const churnedSample = customerData.filter(r => r.Churned === 1).slice(0, 5);
  const activeSample = customerData.filter(r => r.Churned === 0).slice(0, 5);

  let context = `
=== 고객 데이터 통계 요약 (총 ${s.total.toLocaleString()}명) ===
- 이탈률: ${s.churnRate}% (${s.churned.toLocaleString()}명 이탈)
- 평균 연령: ${s.avgAge}세
- 평균 생애가치(LTV): $${s.avgLTV}
- 평균 구매횟수: ${s.avgOrders}회
- 평균 장바구니 이탈률: ${s.avgCartAbandonment}%
- 평균 할인 사용률: ${s.avgDiscount}%
- 평균 이메일 오픈율: ${s.avgEmailOpen}%
- 평균 결제수단 다양성: ${s.avgPaymentDiv}
- 평균 모바일앱 사용: ${s.avgMobileUsage}%
- 고가치 고객(LTV 상위20%): ${s.highValueCount.toLocaleString()}명 (LTV ≥ $${s.topLTVThreshold})

성별 분포: ${JSON.stringify(s.genderDist)}
국가 TOP5: ${s.topCountries.map(([c, n]) => `${c}(${n}명)`).join(', ')}
연령대별 이탈률: ${JSON.stringify(s.churnByAge)}
가입분기 분포: ${JSON.stringify(s.quarterDist)}

데이터 컬럼: ${s.columns.join(', ')}
`;

  if (analysisType === 'churn') {
    // 이탈 고객 샘플 추가
    context += `\n이탈고객 샘플(5명):\n${JSON.stringify(churnedSample, null, 1)}\n`;
    context += `\n유지고객 샘플(5명):\n${JSON.stringify(activeSample, null, 1)}\n`;
  } else if (analysisType === 'segment') {
    // LTV 구간별 추가 분석
    const ltvBuckets = { '저가치(<500)': 0, '중가치(500-1500)': 0, '고가치(1500-3000)': 0, '최고가치(3000+)': 0 };
    customerData.forEach(r => {
      const ltv = parseFloat(r.Lifetime_Value) || 0;
      if (ltv < 500) ltvBuckets['저가치(<500)']++;
      else if (ltv < 1500) ltvBuckets['중가치(500-1500)']++;
      else if (ltv < 3000) ltvBuckets['고가치(1500-3000)']++;
      else ltvBuckets['최고가치(3000+)']++;
    });
    context += `\nLTV 구간 분포: ${JSON.stringify(ltvBuckets)}\n`;
  }

  return context;
}

// ─── API 라우트: 채팅 ─────────────────────────────────────────────────────────
app.post('/api/chat', apiLimiter, async (req, res) => {
  try {
    const { message, history = [], analysisType = 'general' } = req.body;

    // 입력값 검증
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: '메시지를 입력해주세요.' });
    }
    if (message.length > 500) {
      return res.status(400).json({ error: '메시지는 최대 500자까지 입력 가능합니다.' });
    }
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: '잘못된 대화 기록 형식입니다.' });
    }
    if (history.length > 20) {
      return res.status(400).json({ error: '대화 기록이 너무 깁니다.' });
    }

    const dataContext = buildDataContext(analysisType);
    const client = getAnthropicClient();

    const systemPrompt = `당신은 마케팅 AI 에이전트입니다. 5만 명의 실제 고객 데이터를 분석하여 인사이트를 제공합니다.

${dataContext}

【응답 지침】
- 반드시 한국어와 영어를 모두 사용하여 답변하세요 (한국어 주, 영어 부)
- 답변은 핵심만 담아 간결하게 작성하세요 (300~500자 이내)
- 숫자와 통계를 적극 활용하세요
- 실행 가능한 마케팅 제안을 포함하세요
- 단계별로 분석하되, 각 단계는 짧고 명확하게
- 이모지를 적절히 사용하여 가독성을 높이세요
- 답변 끝에 "다음 단계로 무엇을 분석할까요?" 형태로 후속 질문을 제안하세요`;

    // 대화 히스토리 구성 (최근 6개만)
    const recentHistory = history.slice(-6).map(h => ({
      role: h.role,
      content: h.content.substring(0, 500)
    }));

    const messages = [
      ...recentHistory,
      { role: 'user', content: message }
    ];

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });

    const reply = response.content[0]?.text || '응답을 생성할 수 없습니다.';
    res.json({ reply, usage: response.usage });

  } catch (err) {
    console.error('Chat error:', err.message);
    if (err.message.includes('ANTHROPIC_API_KEY')) {
      return res.status(500).json({ error: 'API 키가 설정되지 않았습니다. Cloudtype 환경변수를 확인해주세요.' });
    }
    if (err.message.includes('Connection error') || err.message.includes('fetch failed') || err.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'AI 서버 연결에 실패했습니다. 잠시 후 다시 시도해주세요.' });
    }
    if (err.status === 401) {
      return res.status(500).json({ error: 'API 키가 올바르지 않습니다. Cloudtype 환경변수를 확인해주세요.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.' });
    }
    res.status(500).json({ error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

// ─── API 라우트: 데이터 통계 ──────────────────────────────────────────────────
app.get('/api/stats', apiLimiter, (req, res) => {
  if (!dataStats.total) {
    return res.status(503).json({ error: '데이터를 로드 중입니다.' });
  }
  res.json(dataStats);
});

// ─── API 라우트: PDF 생성 ─────────────────────────────────────────────────────
app.post('/api/export-pdf', pdfLimiter, async (req, res) => {
  try {
    const { chatHistory = [], title = '마케팅 AI 에이전트 분석 보고서' } = req.body;

    if (!Array.isArray(chatHistory) || chatHistory.length === 0) {
      return res.status(400).json({ error: '대화 내용이 없습니다.' });
    }
    if (chatHistory.length > 50) {
      return res.status(400).json({ error: '대화 기록이 너무 많습니다.' });
    }

    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: title,
        Author: 'Marketing AI Agent',
        Creator: 'Marketing AI Agent'
      }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="marketing-ai-report-${Date.now()}.pdf"`);
    doc.pipe(res);

    // 한글 폰트 설정 (내장 폰트 사용, 한글은 유니코드 처리)
    // NanumGothic 폰트가 없을 경우 영문 폰트로 폴백
    let fontAvailable = false;
    const fontPaths = [
      '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
      '/usr/share/fonts/nanum/NanumGothic.ttf',
      path.join(__dirname, 'fonts/NanumGothic.ttf')
    ];
    for (const fp of fontPaths) {
      if (fs.existsSync(fp)) {
        doc.registerFont('Korean', fp);
        fontAvailable = true;
        break;
      }
    }

    const useFont = (size = 12) => {
      if (fontAvailable) {
        doc.font('Korean').fontSize(size);
      } else {
        doc.font('Helvetica').fontSize(size);
      }
    };

    // ── 표지 ──
    doc.rect(0, 0, doc.page.width, 120).fill('#1a1a4e');
    useFont(24);
    doc.fillColor('#ffffff').text('Marketing AI Agent', 50, 30, { align: 'center' });
    useFont(14);
    doc.fillColor('#a0c4ff').text('Analysis Report', 50, 65, { align: 'center' });
    useFont(10);
    doc.fillColor('#cccccc').text(new Date().toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }), 50, 95, { align: 'center' });

    doc.moveDown(3);

    // ── 데이터 요약 박스 ──
    const boxY = 140;
    doc.rect(50, boxY, doc.page.width - 100, 90).fillAndStroke('#f0f4ff', '#3366ff');
    useFont(11);
    doc.fillColor('#1a1a4e')
      .text(`총 고객 수: ${dataStats.total?.toLocaleString()}명`, 70, boxY + 10)
      .text(`이탈률: ${dataStats.churnRate}%  |  평균 LTV: $${dataStats.avgLTV}`, 70, boxY + 28)
      .text(`평균 구매횟수: ${dataStats.avgOrders}회  |  평균 연령: ${dataStats.avgAge}세`, 70, boxY + 46)
      .text(`이메일 오픈율: ${dataStats.avgEmailOpen}%  |  장바구니 이탈률: ${dataStats.avgCartAbandonment}%`, 70, boxY + 64);

    doc.y = boxY + 110;

    // ── 대화 내용 ──
    useFont(14);
    doc.fillColor('#1a1a4e').text('── 분석 대화 내용 ──', { align: 'center' });
    doc.moveDown(0.5);

    chatHistory.forEach((item, idx) => {
      if (doc.y > doc.page.height - 150) doc.addPage();

      const isUser = item.role === 'user';
      const bgColor = isUser ? '#e8f0fe' : '#f0fff4';
      const labelColor = isUser ? '#1a73e8' : '#0d7a3e';
      const label = isUser ? '👤 User' : '🤖 AI Agent';

      const boxX = isUser ? 50 : 60;
      const boxW = doc.page.width - 110;
      const textContent = (item.content || '').replace(/[^\x20-\x7E\uAC00-\uD7A3\u3130-\u318F\uFF00-\uFFEF]/g, '');
      const lines = Math.ceil(textContent.length / 60) + 2;
      const boxH = Math.max(40, lines * 14 + 20);

      if (doc.y + boxH > doc.page.height - 80) doc.addPage();

      doc.rect(boxX, doc.y, boxW, boxH).fill(bgColor);
      useFont(9);
      doc.fillColor(labelColor).text(label, boxX + 8, doc.y + 6);
      useFont(10);
      doc.fillColor('#333333').text(textContent, boxX + 8, doc.y + 20, {
        width: boxW - 16,
        lineGap: 2
      });

      doc.y = doc.y + boxH + 8;
    });

    // ── 푸터 ──
    if (doc.y > doc.page.height - 60) doc.addPage();
    doc.rect(50, doc.page.height - 50, doc.page.width - 100, 1).fill('#cccccc');
    useFont(8);
    doc.fillColor('#999999')
      .text('Generated by Marketing AI Agent | Powered by Claude AI', 50, doc.page.height - 40, { align: 'center' });

    doc.end();

  } catch (err) {
    console.error('PDF error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'PDF 생성 중 오류가 발생했습니다.' });
    }
  }
});

// ─── 헬스체크 ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    dataLoaded: customerData.length > 0,
    totalRecords: customerData.length,
    timestamp: new Date().toISOString()
  });
});

// ─── 프론트엔드 서빙 ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Marketing AI Agent 서버 실행 중: http://localhost:${PORT}`);
  console.log(`📊 고객 데이터: ${customerData.length.toLocaleString()}개 레코드`);
});
