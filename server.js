const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
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

// ─── PDF Generation (Korean font support) ─────────────────────────────────
app.post('/api/pdf', (req, res) => {
  const { messages = [], lang = 'ko', stats } = req.body;
  if (!messages.length) return res.status(400).json({ error: 'No messages' });

  try {
    const fontRegular = path.join(__dirname, 'fonts', 'NanumGothic.ttf');
    const fontBold    = path.join(__dirname, 'fonts', 'NanumGothicBold.ttf');

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="marketing_report_${Date.now()}.pdf"`);
    doc.pipe(res);

    doc.registerFont('Regular', fontRegular);
    doc.registerFont('Bold',    fontBold);

    const PW  = doc.page.width;    // 595
    const PH  = doc.page.height;   // 842
    const ML  = 36, MR = 36;
    const CW  = PW - ML - MR;
    const isKo = lang === 'ko';

    // ── 페이지 상단 여백 (2페이지부터 적용) ──
    const PAGE_TOP    = 24;   // 새 페이지 시작 y
    const PAGE_BOTTOM = PH - 48; // 본문 끝 y (푸터 공간 확보)
    const FOOTER_H    = 28;

    // ── 푸터 그리기 헬퍼 (매 페이지 끝에 호출) ──
    function drawFooter() {
      const fy = PH - FOOTER_H;
      doc.rect(0, fy - 4, PW, FOOTER_H + 4).fill('#f6f7fb');
      doc.font('Regular').fontSize(8).fillColor('#aaaacc')
         .text('Generated by Marketing AI Agent  |  Railway Backend + Claude AI  |  Real CSV Data',
               0, fy + 6, { width: PW, align: 'center' });
    }

    // ── 새 페이지 추가 헬퍼 ──
    function newPage() {
      drawFooter();
      doc.addPage({ margin: 0 });
      return PAGE_TOP;
    }

    // ── 첫 페이지 헤더 ──
    doc.rect(0, 0, PW, 52).fill('#4f8ef7');
    doc.font('Bold').fontSize(16).fillColor('#ffffff')
       .text(isKo ? '마케팅 AI 에이전트 분석 보고서' : 'Marketing AI Agent Report',
             ML, 16, { width: CW });
    doc.font('Regular').fontSize(9).fillColor('rgba(255,255,255,0.75)')
       .text(new Date().toLocaleString('ko-KR'), ML, 36, { width: CW });

    // ── 데이터 정보 바 ──
    doc.rect(0, 52, PW, 22).fill('#eef3ff');
    const infoText = stats
      ? (isKo
          ? `실제 데이터: ${Number(stats.total).toLocaleString()}명  ·  이탈률: ${stats.churn_rate}%  ·  분석 엔진: Claude claude-sonnet-4-5 + Railway`
          : `Real data: ${Number(stats.total).toLocaleString()} customers  ·  Churn rate: ${stats.churn_rate}%  ·  Engine: Claude claude-sonnet-4-5 + Railway`)
      : '';
    doc.font('Regular').fontSize(8).fillColor('#4f8ef7')
       .text(infoText, ML, 60, { width: CW, ellipsis: true });

    let y = 86;

    // ── 차트 이미지 삽입 (있을 경우) ──
    if (req.body.chartImage && req.body.chartTitle) {
      const imgData = req.body.chartImage.replace(/^data:image\/png;base64,/, '');
      const imgBuf  = Buffer.from(imgData, 'base64');
      const imgW    = CW;
      const imgH    = Math.round(CW * 0.55);  // 가로 비율 유지
      if (y + imgH + 30 > PAGE_BOTTOM) { y = newPage(); }
      // 차트 제목
      doc.font('Bold').fontSize(11).fillColor('#1a1a2e')
         .text(req.body.chartTitle, ML, y, { width: CW });
      y += 18;
      doc.image(imgBuf, ML, y, { width: imgW, height: imgH });
      y += imgH + 14;
    }

    // ── 메시지 렌더링 ──
    messages.forEach((m) => {
      const isAI      = m.role === 'ai';
      const label     = isAI ? (isKo ? 'AI 에이전트' : 'AI Agent') : (isKo ? '사용자 질문' : 'User');
      const bgColor   = isAI ? '#f0f5ff' : '#f8f8fa';
      const labelColor = isAI ? '#4f8ef7' : '#6b7280';

      // 텍스트 정제
      const clean = (m.text || '')
        .replace(/▶\s?/g, '> ')
        .replace(/<[^>]+>/g, '')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // 텍스트를 줄 단위로 분리해서 페이지 경계에서 안전하게 나눔
      const lines = clean.split('\n');
      const LINE_H   = 14.5;  // fontSize 10 + lineGap 2 기준 줄 높이
      const LABEL_H  = 22;    // 라벨 영역 높이
      const PAD_V    = 10;    // 블록 상하 내부 패딩
      const BLOCK_GAP = 10;   // 블록 사이 간격

      // 줄들을 페이지 경계에 맞게 그룹으로 나눔
      // 각 '줄'이 실제로 몇 줄로 wrapping될지 계산
      function lineCount(text) {
        if (!text.trim()) return 0.5; // 빈 줄은 절반 높이
        const h = doc.font('Regular').fontSize(10).heightOfString(text, { width: CW - 20 });
        return Math.max(1, h / LINE_H);
      }

      // 블록 전체가 남은 공간에 들어가는지 먼저 시도
      const totalTextH = doc.font('Regular').fontSize(10)
                            .heightOfString(clean, { width: CW - 20, lineGap: 2 });
      const totalBlockH = LABEL_H + PAD_V + totalTextH + PAD_V;

      if (y + totalBlockH <= PAGE_BOTTOM) {
        // ── 통째로 현재 페이지에 그림 ──
        doc.roundedRect(ML, y, CW, totalBlockH, 5).fill(bgColor);
        doc.font('Bold').fontSize(8).fillColor(labelColor)
           .text(label, ML + 10, y + 10, { width: CW - 20 });
        doc.font('Regular').fontSize(10).fillColor('#2a2a3e')
           .text(clean, ML + 10, y + LABEL_H, { width: CW - 20, lineGap: 2 });
        y += totalBlockH + BLOCK_GAP;

      } else {
        // ── 페이지를 걸치는 경우: 줄 단위로 쪼개서 그림 ──
        let isFirstChunk = true;

        // 줄을 그룹으로 모아서 페이지 단위로 출력
        let chunkLines = [];
        let chunkH = LABEL_H + PAD_V; // 첫 청크는 라벨 포함

        const flushChunk = (forcedNewPage) => {
          if (chunkLines.length === 0 && !isFirstChunk) return;

          const chunkText = chunkLines.join('\n');
          const textH = chunkLines.length > 0
            ? doc.font('Regular').fontSize(10).heightOfString(chunkText, { width: CW - 20, lineGap: 2 })
            : 0;
          const blockH = (isFirstChunk ? LABEL_H : 0) + PAD_V + textH + PAD_V;

          // 새 페이지가 필요하면 전환
          if (forcedNewPage) {
            y = newPage();
          }

          // 배경 박스
          doc.roundedRect(ML, y, CW, blockH, 5).fill(bgColor);

          // 첫 청크에만 라벨 표시
          if (isFirstChunk) {
            doc.font('Bold').fontSize(8).fillColor(labelColor)
               .text(label, ML + 10, y + 10, { width: CW - 20 });
          }

          // 텍스트
          if (chunkLines.length > 0) {
            const textY = y + (isFirstChunk ? LABEL_H : PAD_V);
            doc.font('Regular').fontSize(10).fillColor('#2a2a3e')
               .text(chunkText, ML + 10, textY, { width: CW - 20, lineGap: 2 });
          }

          y += blockH + (forcedNewPage ? 0 : BLOCK_GAP);
          chunkLines = [];
          chunkH = PAD_V;
          isFirstChunk = false;
        };

        for (let li = 0; li < lines.length; li++) {
          const line = lines[li];
          const lh = lineCount(line) * LINE_H + 2;

          if (y + chunkH + lh + PAD_V > PAGE_BOTTOM && chunkLines.length > 0) {
            // 현재 청크를 현재 페이지에 flush하고 새 페이지로
            flushChunk(false);
            flushChunk(true); // 새 페이지 시작 (빈 청크로 페이지 전환)
            isFirstChunk = false;
          }

          chunkLines.push(line);
          chunkH += lh;
        }

        // 남은 줄 출력
        if (chunkLines.length > 0) {
          if (y + chunkH + PAD_V > PAGE_BOTTOM) {
            flushChunk(false);
            y = newPage();
            isFirstChunk = false;
          }
          flushChunk(false);
        }

        y += BLOCK_GAP;
      }
    });

    // ── 마지막 페이지 푸터 ──
    drawFooter();
    doc.end();

  } catch (e) {
    console.error('PDF error:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Marketing AI Agent running on port ${PORT}`);
  console.log(`📊 Data rows loaded: ${csvRows.length}`);
});
