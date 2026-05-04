const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const nodemailer  = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));  // 차트 base64 이미지 포함 가능 크기
app.use(express.static(path.join(__dirname, 'public')));

// ─── Load & parse CSV once at startup ───────────────────────────────────────
let csvRows = [];
let richStats = {};
let statsJson = {};

function loadData() {
  try {
    const csvPath = path.join(__dirname, 'data', 'customers.csv');
    const raw = fs.readFileSync(csvPath, 'utf8');
    csvRows = parse(raw, { columns: true, skip_empty_lines: true, cast: true });
    console.log(`✅ CSV loaded: ${csvRows.length} rows`);

    // Load pre-computed stats JSON
    const statsPath = path.join(__dirname, 'data', 'stats.json');
    statsJson = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    console.log(`✅ Stats JSON loaded`);

    // Compute rich stats from CSV for Claude context
    richStats = computeRichStats(csvRows);
    console.log(`✅ Rich stats computed`);
  } catch (e) {
    console.error('Data load error:', e.message);
  }
}

function safeNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function avg(arr) {
  const v = arr.filter(x => x !== null && x !== undefined && !isNaN(x));
  return v.length ? Math.round((v.reduce((a,b)=>a+b,0)/v.length)*100)/100 : 0;
}
function pct(n, total) { return Math.round(n/total*1000)/10; }

function computeRichStats(rows) {
  const total = rows.length;
  const churned = rows.filter(r => String(r.Churned)==='1');
  const active  = rows.filter(r => String(r.Churned)==='0');

  const numCols = [
    'Age','Membership_Years','Login_Frequency','Session_Duration_Avg',
    'Pages_Per_Session','Cart_Abandonment_Rate','Wishlist_Items',
    'Total_Purchases','Average_Order_Value','Days_Since_Last_Purchase',
    'Discount_Usage_Rate','Returns_Rate','Email_Open_Rate',
    'Customer_Service_Calls','Product_Reviews_Written',
    'Social_Media_Engagement_Score','Mobile_App_Usage',
    'Payment_Method_Diversity','Lifetime_Value','Credit_Balance'
  ];

  const metrics = {};
  for (const col of numCols) {
    metrics[col] = {
      overall: avg(rows.map(r => safeNum(r[col]))),
      churned: avg(churned.map(r => safeNum(r[col]))),
      active:  avg(active.map(r => safeNum(r[col])))
    };
  }

  // Country distribution & churn rates
  const countryMap = {};
  rows.forEach(r => {
    const c = r.Country;
    if (!countryMap[c]) countryMap[c] = { total:0, churned:0 };
    countryMap[c].total++;
    if (String(r.Churned)==='1') countryMap[c].churned++;
  });
  const countries = Object.fromEntries(
    Object.entries(countryMap)
      .sort((a,b)=>b[1].total-a[1].total)
      .map(([k,v])=>[k,{...v, rate: pct(v.churned,v.total)}])
  );

  // Gender
  const genderMap = {};
  rows.forEach(r => {
    const g = r.Gender;
    if (!genderMap[g]) genderMap[g] = { total:0, churned:0 };
    genderMap[g].total++;
    if (String(r.Churned)==='1') genderMap[g].churned++;
  });
  const genders = Object.fromEntries(
    Object.entries(genderMap).map(([k,v])=>[k,{...v, rate: pct(v.churned,v.total)}])
  );

  // Age bands
  const ageBands = { '18-29':{t:0,c:0},'30-39':{t:0,c:0},'40-49':{t:0,c:0},'50-59':{t:0,c:0},'60+':{t:0,c:0} };
  rows.forEach(r => {
    const a = safeNum(r.Age);
    if (a===null) return;
    const band = a<30?'18-29':a<40?'30-39':a<50?'40-49':a<60?'50-59':'60+';
    ageBands[band].t++;
    if (String(r.Churned)==='1') ageBands[band].c++;
  });
  Object.values(ageBands).forEach(d => d.rate = d.t ? pct(d.c,d.t) : 0);

  // LTV segments
  const ltvVals = rows.map(r=>safeNum(r.Lifetime_Value)).filter(v=>v!==null).sort((a,b)=>a-b);
  const ltvSegments = {
    low:    rows.filter(r=>safeNum(r.Lifetime_Value) < ltvVals[Math.floor(ltvVals.length*0.33)]).length,
    mid:    rows.filter(r=>{ const v=safeNum(r.Lifetime_Value); return v>=ltvVals[Math.floor(ltvVals.length*0.33)] && v<ltvVals[Math.floor(ltvVals.length*0.66)]; }).length,
    high:   rows.filter(r=>safeNum(r.Lifetime_Value) >= ltvVals[Math.floor(ltvVals.length*0.66)]).length,
    p25:  Math.round(ltvVals[Math.floor(ltvVals.length*0.25)]),
    p50:  Math.round(ltvVals[Math.floor(ltvVals.length*0.50)]),
    p75:  Math.round(ltvVals[Math.floor(ltvVals.length*0.75)]),
    p90:  Math.round(ltvVals[Math.floor(ltvVals.length*0.90)])
  };

  // Top churn risk factors (diff between churned and active)
  const riskFactors = numCols
    .map(col => ({
      col,
      diff: Math.abs(metrics[col].churned - metrics[col].active),
      churned: metrics[col].churned,
      active:  metrics[col].active
    }))
    .sort((a,b)=>b.diff-a.diff)
    .slice(0,8);

  // Signup quarter
  const quarters = {};
  rows.forEach(r => { quarters[r.Signup_Quarter] = (quarters[r.Signup_Quarter]||0)+1; });

  return {
    overview: { total, churned: churned.length, active: active.length,
                churn_rate: pct(churned.length, total) },
    metrics,
    countries,
    genders,
    age_bands: ageBands,
    ltv_segments: ltvSegments,
    risk_factors: riskFactors,
    signup_quarters: quarters
  };
}

loadData();

// ─── Build Claude system prompt from REAL data ────────────────────────────
function buildSystemPrompt(lang='ko') {
  const s = richStats;
  const isKo = lang === 'ko';

  const topCountries = Object.entries(s.countries)
    .slice(0, 7)
    .map(([k,v]) => `${k}: ${v.total}명(이탈률 ${v.rate}%)`)
    .join(', ');

  const riskFactorText = s.risk_factors
    .map(f => `  • ${f.col}: 이탈고객 ${f.churned} vs 유지고객 ${f.active} (차이 ${f.diff.toFixed(1)})`)
    .join('\n');

  const ageBandText = Object.entries(s.age_bands)
    .map(([k,v]) => `  • ${k}세: ${v.t}명, 이탈률 ${v.rate}%`)
    .join('\n');

  const genderText = Object.entries(s.genders)
    .map(([k,v]) => `  • ${k}: ${v.total}명, 이탈률 ${v.rate}%`)
    .join('\n');

  return `당신은 전문 마케팅 AI 에이전트입니다. 아래는 GitHub에서 로드된 실제 이커머스 고객 데이터(${s.overview.total.toLocaleString()}명)의 분석 결과입니다.

═══════════════════════════════
📊 실제 데이터 기반 통계 (실시간 로드)
═══════════════════════════════

[전체 개요]
• 총 고객 수: ${s.overview.total.toLocaleString()}명
• 이탈 고객: ${s.overview.churned.toLocaleString()}명 (${s.overview.churn_rate}%)
• 유지 고객: ${s.overview.active.toLocaleString()}명 (${(100-s.overview.churn_rate).toFixed(1)}%)

[국가별 분포 및 이탈률]
${topCountries}

[성별 분포]
${genderText}

[연령대별 이탈률]
${ageBandText}

[LTV(고객생애가치) 분포]
• 하위 25%: $${s.ltv_segments.p25}
• 중간(50%): $${s.ltv_segments.p50}
• 상위 25%: $${s.ltv_segments.p75}
• 상위 10%: $${s.ltv_segments.p90}

[주요 평균 지표 - 이탈 vs 유지 고객 비교]
• 평균 나이: 이탈 ${s.metrics.Age.churned} / 유지 ${s.metrics.Age.active}세
• 로그인 빈도: 이탈 ${s.metrics.Login_Frequency.churned} / 유지 ${s.metrics.Login_Frequency.active}회
• 장바구니 이탈률: 이탈고객 ${s.metrics.Cart_Abandonment_Rate.churned}% / 유지고객 ${s.metrics.Cart_Abandonment_Rate.active}%
• 마지막 구매 후 경과일: 이탈 ${s.metrics.Days_Since_Last_Purchase.churned}일 / 유지 ${s.metrics.Days_Since_Last_Purchase.active}일
• 이메일 오픈율: 이탈 ${s.metrics.Email_Open_Rate.churned}% / 유지 ${s.metrics.Email_Open_Rate.active}%
• 평균 주문금액: 이탈 $${s.metrics.Average_Order_Value.churned} / 유지 $${s.metrics.Average_Order_Value.active}
• 할인 사용률: 이탈 ${s.metrics.Discount_Usage_Rate.churned}% / 유지 ${s.metrics.Discount_Usage_Rate.active}%
• 반품률: 이탈 ${s.metrics.Returns_Rate.churned}% / 유지 ${s.metrics.Returns_Rate.active}%
• 고객서비스 문의: 이탈 ${s.metrics.Customer_Service_Calls.churned}회 / 유지 ${s.metrics.Customer_Service_Calls.active}회
• 모바일 앱 사용: 이탈 ${s.metrics.Mobile_App_Usage.churned} / 유지 ${s.metrics.Mobile_App_Usage.active}
• 소셜미디어 참여: 이탈 ${s.metrics.Social_Media_Engagement_Score.churned} / 유지 ${s.metrics.Social_Media_Engagement_Score.active}
• 평균 LTV: 이탈 $${s.metrics.Lifetime_Value.churned} / 유지 $${s.metrics.Lifetime_Value.active}

[이탈 위험 주요 인자 (데이터 기반 상위 8개)]
${riskFactorText}

[가입 분기별 분포]
${Object.entries(s.signup_quarters).map(([k,v])=>`  • ${k}: ${v}명`).join('\n')}

═══════════════════════════════
📌 응답 규칙
═══════════════════════════════
1. 위 실제 데이터 수치를 정확히 인용하여 답변하라.
2. 응답은 ${isKo ? '한국어' : 'English'}로 작성하라.
3. 반드시 300토큰 이내로 간결하게 답변 (20-30초 응답 목표).
4. 각 답변 마지막에 ▶ 로 시작하는 후속 질문 2-3개 제안.
5. 실행 가능한 마케팅 인사이트에 집중하라.
6. 복잡한 분석은 단계별로 나눠서 안내하라.
7. 숫자는 실제 데이터 기반으로만 언급하라 (추측 금지).`;
}

// ─── API Routes ───────────────────────────────────────────────────────────

// Health check & stats endpoint
app.get('/api/stats', (req, res) => {
  if (!richStats.overview) return res.status(503).json({ error: 'Data not loaded' });
  res.json({
    status: 'ok',
    loaded: true,
    overview: richStats.overview,
    top_countries: Object.entries(richStats.countries)
      .slice(0,5)
      .map(([k,v])=>({ country:k, total:v.total, churned:v.churned, rate:v.rate })),
    genders: richStats.genders,
    age_bands: richStats.age_bands,
    ltv_segments: richStats.ltv_segments,
    risk_factors: richStats.risk_factors.slice(0,5),
    avg_metrics: richStats.metrics   // 이탈/유지 평균 비교 지표
  });
});

// Main chat endpoint - proxies to Claude with real data context
app.post('/api/chat', async (req, res) => {
  const { messages, apiKey, lang = 'ko' } = req.body;

  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages required' });

  if (!richStats.overview) {
    return res.status(503).json({ error: 'Data not loaded yet. Please retry.' });
  }

  try {
    const client = new Anthropic({ apiKey });
    const systemPrompt = buildSystemPrompt(lang);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system: systemPrompt,
      messages: messages.slice(-20)
    });

    res.json({
      content: response.content[0].text,
      usage: response.usage,
      data_rows: richStats.overview.total
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message || 'Claude API error' });
  }
});

// Query specific data slices
app.post('/api/query', (req, res) => {
  const { type, params = {} } = req.body;
  if (!csvRows.length) return res.status(503).json({ error: 'Data not loaded' });

  let result = {};

  switch(type) {
    case 'segment': {
      // Filter by country, gender, age range
      let filtered = csvRows;
      if (params.country) filtered = filtered.filter(r => r.Country === params.country);
      if (params.gender)  filtered = filtered.filter(r => r.Gender  === params.gender);
      if (params.minAge)  filtered = filtered.filter(r => safeNum(r.Age) >= params.minAge);
      if (params.maxAge)  filtered = filtered.filter(r => safeNum(r.Age) <= params.maxAge);
      const ch = filtered.filter(r => String(r.Churned)==='1').length;
      result = {
        total: filtered.length,
        churned: ch,
        churn_rate: filtered.length ? pct(ch, filtered.length) : 0,
        avg_ltv: avg(filtered.map(r=>safeNum(r.Lifetime_Value))),
        avg_aov: avg(filtered.map(r=>safeNum(r.Average_Order_Value)))
      };
      break;
    }
    case 'top_churn_cities': {
      const cityMap = {};
      csvRows.forEach(r => {
        const key = `${r.City}(${r.Country})`;
        if (!cityMap[key]) cityMap[key] = { total:0, churned:0 };
        cityMap[key].total++;
        if (String(r.Churned)==='1') cityMap[key].churned++;
      });
      result = Object.entries(cityMap)
        .filter(([,v])=>v.total>=50)
        .map(([k,v])=>({city:k, ...v, rate:pct(v.churned,v.total)}))
        .sort((a,b)=>b.rate-a.rate)
        .slice(0, params.limit||10);
      break;
    }
    case 'vip_profile': {
      const ltvVals = csvRows.map(r=>safeNum(r.Lifetime_Value)).filter(v=>v!==null).sort((a,b)=>a-b);
      const p90 = ltvVals[Math.floor(ltvVals.length*0.9)];
      const vips = csvRows.filter(r => safeNum(r.Lifetime_Value) >= p90);
      const vipChurned = vips.filter(r => String(r.Churned)==='1');
      result = {
        count: vips.length,
        churn_count: vipChurned.length,
        churn_rate: pct(vipChurned.length, vips.length),
        ltv_threshold: Math.round(p90),
        avg_ltv: avg(vips.map(r=>safeNum(r.Lifetime_Value))),
        avg_login: avg(vips.map(r=>safeNum(r.Login_Frequency))),
        avg_aov: avg(vips.map(r=>safeNum(r.Average_Order_Value))),
        countries: Object.entries(
          vips.reduce((acc,r)=>{acc[r.Country]=(acc[r.Country]||0)+1;return acc;},{})
        ).sort((a,b)=>b[1]-a[1]).slice(0,5)
      };
      break;
    }
    default:
      result = { error: 'Unknown query type' };
  }

  res.json(result);
});

// ─── PDF Generation ──────────────────────────────────────────────────────────
app.post('/api/pdf', (req, res) => {
  const { messages = [], lang = 'ko', stats } = req.body;
  if (!messages.length && !req.body.chartImage) {
    return res.status(400).json({ error: 'No content' });
  }

  try {
    const fontRegular = path.join(__dirname, 'fonts', 'NanumGothic.ttf');
    const fontBold    = path.join(__dirname, 'fonts', 'NanumGothicBold.ttf');

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="marketing_report_${Date.now()}.pdf"`);
    doc.pipe(res);

    doc.registerFont('Regular', fontRegular);
    doc.registerFont('Bold',    fontBold);

    const PW = doc.page.width;   // 595
    const PH = doc.page.height;  // 842
    const ML = 36, CW = PW - 72;
    const isKo  = lang === 'ko';
    const P_TOP = 28;            // 새 페이지 본문 시작 y
    const P_BOT = PH - 44;       // 본문 끝 y (푸터 공간)

    // ── 푸터 ──
    function drawFooter() {
      doc.save();
      doc.rect(0, PH - 30, PW, 30).fill('#f6f7fb');
      doc.font('Regular').fontSize(8).fillColor('#aaaacc')
         .text('Generated by Marketing AI Agent  |  Railway + Claude AI  |  Real CSV Data',
               0, PH - 20, { width: PW, align: 'center' });
      doc.restore();
    }

    // ── 새 페이지 ──
    function newPage() {
      drawFooter();
      doc.addPage({ margin: 0 });
      return P_TOP;
    }

    // ── 헤더 (1페이지) ──
    doc.rect(0, 0, PW, 50).fill('#4f8ef7');
    doc.font('Bold').fontSize(15).fillColor('#ffffff')
       .text(isKo ? '마케팅 AI 에이전트 분석 보고서' : 'Marketing AI Agent Report',
             ML, 14, { width: CW });
    doc.font('Regular').fontSize(9).fillColor('rgba(255,255,255,0.75)')
       .text(new Date().toLocaleString('ko-KR'), ML, 34, { width: CW });

    // ── 정보 바 ──
    doc.rect(0, 50, PW, 20).fill('#eef3ff');
    if (stats) {
      const info = isKo
        ? `실제 데이터: ${Number(stats.total).toLocaleString()}명  ·  이탈률: ${stats.churn_rate}%  ·  Claude claude-sonnet-4-5`
        : `Real data: ${Number(stats.total).toLocaleString()} customers  ·  Churn: ${stats.churn_rate}%  ·  Claude claude-sonnet-4-5`;
      doc.font('Regular').fontSize(8).fillColor('#4f8ef7')
         .text(info, ML, 57, { width: CW, ellipsis: true });
    }

    let y = 80;

    // ── 차트 이미지 삽입 ──
    if (req.body.chartImage && req.body.chartTitle) {
      // JPEG base64 디코딩
      const b64 = req.body.chartImage
        .replace(/^data:image\/(jpeg|png|webp);base64,/, '');
      const imgBuf = Buffer.from(b64, 'base64');

      const imgW = CW;
      const imgH = Math.round(CW * 0.58);

      // 제목
      if (y + 18 + imgH > P_BOT) { y = newPage(); }
      doc.font('Bold').fontSize(12).fillColor('#1a1a2e')
         .text(req.body.chartTitle, ML, y, { width: CW });
      y += 20;

      // 이미지
      if (y + imgH > P_BOT) { y = newPage(); }
      doc.image(imgBuf, ML, y, { width: imgW, height: imgH });
      y += imgH + 16;
    }

    // ── 메시지 렌더링 ──
    const LINE_H   = 15;
    const LABEL_H  = 22;
    const PAD      = 10;
    const GAP      = 10;

    function textH(str, w) {
      return doc.font('Regular').fontSize(10).heightOfString(str, { width: w, lineGap: 2 });
    }

    // 텍스트를 페이지 단위로 청크 분할해서 출력
    function renderBlock(role, clean) {
      const isAI     = role === 'ai';
      const label    = isAI ? (isKo ? 'AI 에이전트' : 'AI Agent') : (isKo ? '사용자 질문' : 'User');
      const bg       = isAI ? '#f0f5ff' : '#f8f8fa';
      const lc       = isAI ? '#4f8ef7' : '#6b7280';
      const innerW   = CW - 20;

      const totalTH  = textH(clean, innerW);
      const totalBH  = LABEL_H + PAD + totalTH + PAD;

      if (y + totalBH <= P_BOT) {
        // ── 한 페이지에 전부 들어감 ──
        doc.roundedRect(ML, y, CW, totalBH, 5).fill(bg);
        doc.font('Bold').fontSize(8).fillColor(lc)
           .text(label, ML + 10, y + 10, { width: innerW });
        doc.font('Regular').fontSize(10).fillColor('#2a2a3e')
           .text(clean, ML + 10, y + LABEL_H, { width: innerW, lineGap: 2 });
        y += totalBH + GAP;
        return;
      }

      // ── 여러 페이지에 걸침: 줄 단위로 분할 ──
      const lines = clean.split('\n');
      let chunk    = [];
      let chunkTH  = 0;
      let firstChunk = true;

      function flush() {
        if (chunk.length === 0) return;
        const ct  = chunk.join('\n');
        const cth = textH(ct, innerW);
        const cbh = (firstChunk ? LABEL_H : 0) + PAD + cth + PAD;

        // 남은 공간 부족하면 새 페이지
        if (y + cbh > P_BOT) { y = newPage(); }

        doc.roundedRect(ML, y, CW, cbh, 5).fill(bg);
        if (firstChunk) {
          doc.font('Bold').fontSize(8).fillColor(lc)
             .text(label, ML + 10, y + 10, { width: innerW });
        }
        const ty = y + (firstChunk ? LABEL_H : PAD);
        doc.font('Regular').fontSize(10).fillColor('#2a2a3e')
           .text(ct, ML + 10, ty, { width: innerW, lineGap: 2 });

        y += cbh + GAP;
        chunk = [];
        chunkTH = 0;
        firstChunk = false;
      }

      for (const line of lines) {
        const lh = line.trim()
          ? textH(line, innerW)
          : LINE_H * 0.5;

        // 이 줄을 추가하면 현재 페이지를 넘치는가?
        const extraHeader = firstChunk ? LABEL_H : 0;
        const needed = extraHeader + PAD + chunkTH + lh + PAD;

        if (chunk.length > 0 && y + needed > P_BOT) {
          flush();   // 현재 청크를 현재 페이지에 출력
        }
        chunk.push(line);
        chunkTH += lh + 2;
      }
      flush(); // 나머지 출력
    }

    messages.forEach(m => {
      const clean = (m.text || '')
        .replace(/▶\s?/g, '> ')
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (clean) renderBlock(m.role, clean);
    });

    drawFooter();
    doc.end();

  } catch (e) {
    console.error('PDF error:', e.message, e.stack);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ─── PDF-ALL: 차트 이미지 + 텍스트 전체 대화 PDF ───────────────────────────
app.post('/api/pdf-all', (req, res) => {
  const { items = [], lang = 'ko', stats } = req.body;
  if (!items.length) return res.status(400).json({ error: 'No items' });

  try {
    const fontRegular = path.join(__dirname, 'fonts', 'NanumGothic.ttf');
    const fontBold    = path.join(__dirname, 'fonts', 'NanumGothicBold.ttf');

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="marketing_full_${Date.now()}.pdf"`);
    doc.pipe(res);

    doc.registerFont('Regular', fontRegular);
    doc.registerFont('Bold',    fontBold);

    const PW = doc.page.width;
    const PH = doc.page.height;
    const ML = 36, CW = PW - 72;
    const isKo  = lang === 'ko';
    const P_TOP = 28;
    const P_BOT = PH - 44;

    function drawFooter() {
      doc.save();
      doc.rect(0, PH - 30, PW, 30).fill('#f6f7fb');
      doc.font('Regular').fontSize(8).fillColor('#aaaacc')
         .text('Generated by Marketing AI Agent  |  Railway + Claude AI  |  Real CSV Data',
               0, PH - 20, { width: PW, align: 'center' });
      doc.restore();
    }

    function newPage() {
      drawFooter();
      doc.addPage({ margin: 0 });
      return P_TOP;
    }

    // 헤더
    doc.rect(0, 0, PW, 50).fill('#4f8ef7');
    doc.font('Bold').fontSize(15).fillColor('#ffffff')
       .text(isKo ? '마케팅 AI 에이전트 분석 보고서' : 'Marketing AI Agent Report',
             ML, 14, { width: CW });
    doc.font('Regular').fontSize(9).fillColor('rgba(255,255,255,0.75)')
       .text(new Date().toLocaleString('ko-KR'), ML, 34, { width: CW });

    doc.rect(0, 50, PW, 20).fill('#eef3ff');
    if (stats) {
      const info = isKo
        ? `실제 데이터: ${Number(stats.total).toLocaleString()}명  ·  이탈률: ${stats.churn_rate}%  ·  Claude claude-sonnet-4-5`
        : `Real data: ${Number(stats.total).toLocaleString()} customers  ·  Churn: ${stats.churn_rate}%  ·  Claude claude-sonnet-4-5`;
      doc.font('Regular').fontSize(8).fillColor('#4f8ef7')
         .text(info, ML, 57, { width: CW, ellipsis: true });
    }

    let y = 80;

    function textH(str, w) {
      return doc.font('Regular').fontSize(10).heightOfString(str, { width: w, lineGap: 2 });
    }

    const LABEL_H = 22, PAD = 10, GAP = 10;

    function renderTextBlock(role, clean) {
      if (!clean || !clean.trim()) return;
      const isAI    = role === 'ai';
      const label   = isAI ? (isKo ? 'AI 에이전트' : 'AI Agent') : (isKo ? '사용자 질문' : 'User');
      const bg      = isAI ? '#f0f5ff' : '#f8f8fa';
      const lc      = isAI ? '#4f8ef7' : '#6b7280';
      const innerW  = CW - 20;
      const totalTH = textH(clean, innerW);
      const totalBH = LABEL_H + PAD + totalTH + PAD;

      if (y + totalBH <= P_BOT) {
        doc.roundedRect(ML, y, CW, totalBH, 5).fill(bg);
        doc.font('Bold').fontSize(8).fillColor(lc)
           .text(label, ML + 10, y + 10, { width: innerW });
        doc.font('Regular').fontSize(10).fillColor('#2a2a3e')
           .text(clean, ML + 10, y + LABEL_H, { width: innerW, lineGap: 2 });
        y += totalBH + GAP;
        return;
      }

      // 줄 단위 분할
      const lines = clean.split('\n');
      let chunk = [], chunkTH = 0, firstChunk = true;

      function flush() {
        if (!chunk.length) return;
        const ct  = chunk.join('\n');
        const cth = textH(ct, innerW);
        const cbh = (firstChunk ? LABEL_H : 0) + PAD + cth + PAD;
        if (y + cbh > P_BOT) { y = newPage(); }
        doc.roundedRect(ML, y, CW, cbh, 5).fill(bg);
        if (firstChunk) {
          doc.font('Bold').fontSize(8).fillColor(lc)
             .text(label, ML + 10, y + 10, { width: innerW });
        }
        const ty = y + (firstChunk ? LABEL_H : PAD);
        doc.font('Regular').fontSize(10).fillColor('#2a2a3e')
           .text(ct, ML + 10, ty, { width: innerW, lineGap: 2 });
        y += cbh + GAP;
        chunk = []; chunkTH = 0; firstChunk = false;
      }

      for (const line of lines) {
        const lh = line.trim() ? textH(line, innerW) : 7.5;
        const extra = firstChunk ? LABEL_H : 0;
        if (chunk.length > 0 && y + extra + PAD + chunkTH + lh + PAD > P_BOT) flush();
        chunk.push(line);
        chunkTH += lh + 2;
      }
      flush();
    }

    function renderChartBlock(item) {
      if (!item.imgData) return;
      const b64    = item.imgData.replace(/^data:image\/(jpeg|png|webp);base64,/, '');
      const imgBuf = Buffer.from(b64, 'base64');
      const imgW   = CW;
      const imgH   = Math.round(CW * 0.58);
      const titleH = 20;
      const needed = titleH + imgH + GAP;

      if (y + needed > P_BOT) { y = newPage(); }

      // 차트 제목 배경
      doc.roundedRect(ML, y, CW, titleH, 5).fill('#f0f5ff');
      doc.font('Bold').fontSize(11).fillColor('#4f8ef7')
         .text(item.title || (isKo ? '차트' : 'Chart'),
               ML + 10, y + 4, { width: CW - 20 });
      y += titleH + 4;

      // 이미지
      if (y + imgH > P_BOT) { y = newPage(); }
      doc.image(imgBuf, ML, y, { width: imgW, height: imgH });
      y += imgH + GAP;
    }

    // 아이템 순서대로 렌더링
    for (const item of items) {
      if (item.role === 'chart') {
        renderChartBlock(item);
      } else {
        renderTextBlock(item.role, (item.text || '').trim());
      }
    }

    // ── 끝 표시 ──
    const END_H = 36;
    if (y + END_H > P_BOT) { y = newPage(); }
    doc.roundedRect(ML, y, CW, END_H, 8).fill('#1a1a2e');
    doc.font('Bold').fontSize(12).fillColor('#ffffff')
       .text(isKo ? '— 보고서 끝 —' : '— End of Report —',
             0, y + 11, { width: PW, align: 'center' });
    y += END_H + GAP;

    drawFooter();
    doc.end();

  } catch (e) {
    console.error('PDF-ALL error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});


// ─── 인터랙티브 대시보드: AI 분석 생성 ─────────────────────────────────────
app.post('/api/dashboard', async (req, res) => {
  const { apiKey, lang = 'ko' } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  if (!richStats.overview) return res.status(503).json({ error: 'Data not loaded' });

  const isKo = lang === 'ko';
  const s = richStats;

  // 3개 섹션을 병렬로 Claude에게 요청
  const client = new Anthropic({ apiKey });

  const makePrompt = (section) => {
    const base = `당신은 전문 마케팅 데이터 분석가입니다. 아래 실제 데이터를 기반으로 분석하세요.

[데이터 요약]
- 총 고객: ${s.overview.total.toLocaleString()}명
- 이탈 고객: ${s.overview.churned.toLocaleString()}명 (${s.overview.churn_rate}%)
- 유지 고객: ${s.overview.active.toLocaleString()}명
- 평균 LTV: $${s.metrics.Lifetime_Value.overall}
- 이탈고객 LTV: $${s.metrics.Lifetime_Value.churned} / 유지고객 LTV: $${s.metrics.Lifetime_Value.active}
- 장바구니이탈률: 이탈고객 ${s.metrics.Cart_Abandonment_Rate.churned}% / 유지고객 ${s.metrics.Cart_Abandonment_Rate.active}%
- 마지막구매경과일: 이탈 ${s.metrics.Days_Since_Last_Purchase.churned}일 / 유지 ${s.metrics.Days_Since_Last_Purchase.active}일
- 이메일오픈율: 이탈 ${s.metrics.Email_Open_Rate.churned}% / 유지 ${s.metrics.Email_Open_Rate.active}%
- 로그인빈도: 이탈 ${s.metrics.Login_Frequency.churned} / 유지 ${s.metrics.Login_Frequency.active}회
- 할인사용률: 이탈 ${s.metrics.Discount_Usage_Rate.churned}% / 유지 ${s.metrics.Discount_Usage_Rate.active}%
- 반품률: 이탈 ${s.metrics.Returns_Rate.churned}% / 유지 ${s.metrics.Returns_Rate.active}%
- 국가별(상위5): ${Object.entries(s.countries).slice(0,5).map(([k,v])=>`${k} ${v.rate}%`).join(', ')}
- 연령대별 이탈률: ${Object.entries(s.age_bands).map(([k,v])=>`${k}세 ${v.rate}%`).join(', ')}
- LTV 분위: P25=$${s.ltv_segments.p25}, P50=$${s.ltv_segments.p50}, P75=$${s.ltv_segments.p75}, P90=$${s.ltv_segments.p90}`;

    const sections = {
      segmentation: `${base}

[요청] 1. 고객 분석 및 세분화 분석을 수행하세요.
- RFM 기반 고객 세그먼트 (VIP/일반/이탈위험/휴면) 정의 및 규모 추정
- 연령대·국가·성별별 핵심 인사이트
- 고객 생애주기별 특성
- 세그먼트별 맞춤 전략 제언
응답은 ${isKo?'한국어':'English'}로, 명확한 섹션 구분과 핵심 수치를 포함해 500토큰 이내로 작성하세요.`,

      churn: `${base}

[요청] 2. 고객 이탈 예측 모델링 분석을 수행하세요.
- 이탈 예측 주요 변수 Top 5 및 영향도 (데이터 근거)
- 이탈 위험 고객 프로파일 (특징 3가지)
- 이탈 예측 모델 권장 알고리즘 (로지스틱회귀/랜덤포레스트/XGBoost 비교)
- 조기 이탈 징후 지표 및 임계값 제안
응답은 ${isKo?'한국어':'English'}로, 명확한 섹션 구분과 핵심 수치를 포함해 500토큰 이내로 작성하세요.`,

      marketing: `${base}

[요청] 3. 마케팅 최적화 방안을 제시하세요.
- 이탈 방지 캠페인 전략 (채널·타이밍·메시지)
- VIP 고객 유지 프로그램 설계
- 이메일 캠페인 최적화 방안 (오픈율 개선)
- 할인/프로모션 전략 (할인 의존도 낮추기)
- 예상 ROI 및 우선순위 실행 로드맵
응답은 ${isKo?'한국어':'English'}로, 명확한 섹션 구분과 핵심 수치를 포함해 500토큰 이내로 작성하세요.`
    };
    return sections[section];
  };

  try {
    const [seg, churn, mkt] = await Promise.all([
      client.messages.create({ model:'claude-sonnet-4-5', max_tokens:600, messages:[{role:'user',content:makePrompt('segmentation')}] }),
      client.messages.create({ model:'claude-sonnet-4-5', max_tokens:600, messages:[{role:'user',content:makePrompt('churn')}] }),
      client.messages.create({ model:'claude-sonnet-4-5', max_tokens:600, messages:[{role:'user',content:makePrompt('marketing')}] }),
    ]);

    res.json({
      segmentation: seg.content[0].text,
      churn:        churn.content[0].text,
      marketing:    mkt.content[0].text,
      generated_at: new Date().toISOString(),
      data_rows:    s.overview.total
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 메일 발송 엔드포인트 ────────────────────────────────────────────────────
app.post('/api/send-report', async (req, res) => {
  const { segmentation, churn, marketing, lang = 'ko' } = req.body;
  if (!segmentation || !churn || !marketing) {
    return res.status(400).json({ error: '분석 결과가 없습니다. 먼저 대시보드를 실행하세요.' });
  }

  // 환경변수에서 메일 설정 로드
  const MAIL_USER = process.env.MAIL_USER;
  const MAIL_PASS = process.env.MAIL_PASS;
  const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || '마케팅 AI 에이전트';

  if (!MAIL_USER || !MAIL_PASS) {
    return res.status(500).json({ error: 'Railway 환경변수 MAIL_USER, MAIL_PASS가 설정되지 않았습니다.' });
  }

  // mailing_list.txt 읽기
  const listPath = path.join(__dirname, 'mailing_list.txt');
  if (!fs.existsSync(listPath)) {
    return res.status(500).json({ error: 'mailing_list.txt 파일이 없습니다.' });
  }
  const recipients = fs.readFileSync(listPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && l.includes('@'));

  if (recipients.length === 0) {
    return res.status(400).json({ error: '유효한 수신자가 없습니다.' });
  }

  // 메일 HTML 생성
  const now = new Date().toLocaleString('ko-KR');
  const s = richStats;

  const htmlBody = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<style>
  body{font-family:'Malgun Gothic',sans-serif;background:#f5f7fa;margin:0;padding:0}
  .wrap{max-width:680px;margin:0 auto;background:white}
  .header{background:linear-gradient(135deg,#4f8ef7,#7c5cbf);padding:32px 28px;color:white;text-align:center}
  .header h1{font-size:22px;margin:0 0 8px}
  .header p{font-size:13px;opacity:.85;margin:0}
  .intro{background:#eef3ff;border-left:4px solid #4f8ef7;padding:18px 24px;margin:24px;border-radius:0 8px 8px 0;font-size:14px;line-height:1.7;color:#333}
  .stats-row{display:flex;gap:12px;padding:0 24px 20px;flex-wrap:wrap}
  .stat-box{flex:1;min-width:120px;background:#f8f9ff;border:1px solid #e0e8ff;border-radius:10px;padding:14px;text-align:center}
  .stat-val{font-size:22px;font-weight:700;color:#4f8ef7}
  .stat-lbl{font-size:11px;color:#888;margin-top:4px}
  .section{margin:0 24px 24px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden}
  .section-header{background:#4f8ef7;color:white;padding:14px 18px;font-size:15px;font-weight:700}
  .section-header.churn{background:#ef4444}
  .section-header.mkt{background:#7c5cbf}
  .section-body{padding:18px;font-size:13px;line-height:1.8;color:#333;white-space:pre-wrap}
  .footer{background:#f8f9ff;padding:20px 24px;text-align:center;font-size:11px;color:#aaa;border-top:1px solid #e5e7eb}
</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>📊 마케팅 AI 에이전트 분석 보고서</h1>
    <p>생성일시: ${now} · 분석 고객 수: ${s.overview.total.toLocaleString()}명</p>
  </div>

  <div class="intro">
    AI 전략 마케팅 강의 보조자료로 마케팅 AI 에이전트를 실제로 구현하여 분석한
    Business Intelligence의 output을 AI 에이전트가 보내드리는 메일입니다.
  </div>

  <div class="stats-row">
    <div class="stat-box"><div class="stat-val">${s.overview.total.toLocaleString()}</div><div class="stat-lbl">총 고객 수</div></div>
    <div class="stat-box"><div class="stat-val" style="color:#ef4444">${s.overview.churn_rate}%</div><div class="stat-lbl">이탈률</div></div>
    <div class="stat-box"><div class="stat-val">$${s.metrics.Lifetime_Value.overall}</div><div class="stat-lbl">평균 LTV</div></div>
    <div class="stat-box"><div class="stat-val">${s.metrics.Email_Open_Rate.active}%</div><div class="stat-lbl">이메일 오픈율(유지)</div></div>
  </div>

  <div class="section">
    <div class="section-header">🎯 1. 고객 분석 및 세분화</div>
    <div class="section-body">${segmentation.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  </div>

  <div class="section">
    <div class="section-header churn">⚠️ 2. 고객 이탈 예측 모델링</div>
    <div class="section-body">${churn.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  </div>

  <div class="section">
    <div class="section-header mkt">💡 3. 마케팅 최적화 방안</div>
    <div class="section-body">${marketing.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  </div>

  <div class="footer">
    본 보고서는 마케팅 AI 에이전트가 자동 생성했습니다.<br>
    분석 엔진: Claude claude-sonnet-4-5 · 데이터: E-Commerce 고객 ${s.overview.total.toLocaleString()}명 · Railway 백엔드
  </div>
</div>
</body></html>`;

  // Gmail SMTP 발송
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: MAIL_USER, pass: MAIL_PASS }
  });

  try {
    await transporter.verify();
  } catch(e) {
    return res.status(500).json({ error: `메일 서버 연결 실패: ${e.message}` });
  }

  // 수신자에게 순차 발송
  const results = [];
  for (const to of recipients) {
    try {
      await transporter.sendMail({
        from: `"${MAIL_FROM_NAME}" <${MAIL_USER}>`,
        to,
        subject: `[마케팅 AI 에이전트] E-Commerce 고객 분석 보고서 - ${now}`,
        html: htmlBody
      });
      results.push({ to, status: 'sent' });
    } catch(e) {
      results.push({ to, status: 'failed', error: e.message });
    }
  }

  const sent   = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'failed').length;
  res.json({ success: true, sent, failed, total: recipients.length, results });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Marketing AI Agent running on port ${PORT}`);
  console.log(`📊 Data rows loaded: ${csvRows.length}`);
});
