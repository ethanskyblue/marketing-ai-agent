# 🚀 마케팅 AI 에이전트 - 배포 가이드

## 아키텍처

```
[휴대폰 브라우저]
      ↕ HTTPS
[Railway 서버 (Node.js / server.js)]
  ├─ 서버 시작 시 → /data/customers.csv 로드 & 통계 계산
  ├─ GET  /api/stats   → 실시간 데이터 통계 반환
  ├─ POST /api/chat    → Claude API 호출 (실제 데이터 컨텍스트 주입)
  └─ GET  /*           → public/index.html 서빙
```

CSV 파일은 GitHub → Railway 서버에서 직접 읽힘.  
프론트엔드는 절대 CSV에 직접 접근하지 않고, 백엔드 `/api/chat`을 통해 Claude가 실제 데이터로 답변.

---

## 📁 프로젝트 구조

```
marketing-agent/
├── server.js            # Railway 백엔드 (Express + Anthropic SDK)
├── package.json
├── railway.toml         # Railway 배포 설정
├── .gitignore
├── data/
│   ├── customers.csv    # 50,000명 고객 데이터 (GitHub에 포함)
│   └── stats.json       # 사전 계산 통계 (선택)
└── public/
    └── index.html       # 프론트엔드 (지문 인증 + AI 채팅 + PDF)
```

---

## 🛠️ GitHub 업로드

### 1단계: GitHub 저장소 생성
1. https://github.com/new 접속
2. Repository name: `marketing-ai-agent`
3. Private 선택 (API 키 노출 방지)
4. Create repository 클릭

### 2단계: 파일 업로드
```bash
# 로컬에서 실행
git init
git add .
git commit -m "Initial commit: Marketing AI Agent"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/marketing-ai-agent.git
git push -u origin main
```

> ⚠️ `.gitignore`에 `node_modules/`와 `.env`가 포함되어 있습니다.
> `data/customers.csv`는 GitHub에 포함됩니다 (Railway가 읽어야 하므로).

---

## 🚂 Railway 배포

### 1단계: Railway 프로젝트 생성
1. https://railway.app 접속 → Login with GitHub
2. **New Project** 클릭
3. **Deploy from GitHub repo** 선택
4. `marketing-ai-agent` 저장소 선택

### 2단계: 자동 배포 확인
- Railway가 `package.json`을 감지하고 자동으로 `npm install` + `npm start` 실행
- `railway.toml`의 설정이 적용됨
- 배포 완료 후 Railway가 URL 제공 (예: `https://marketing-ai-agent.up.railway.app`)

### 3단계: 환경 변수 (선택)
Railway Dashboard → Variables:
```
PORT=3000  # Railway가 자동 설정하므로 불필요
```

---

## 📱 앱 사용 방법

### 최초 접속 (휴대폰)
1. Railway URL을 휴대폰 브라우저로 열기
2. 잠금 화면에서 **"API 키 재설정"** 버튼 클릭
3. Anthropic API 키 입력 (`sk-ant-api03-...`)
4. 저장 → 지문 애니메이션 자동 인증 → 앱 열림

### 이후 접속
1. 잠금 화면의 지문 이미지 터치
2. 약 1.5초 인증 → 앱 자동 열림

### AI 에이전트 사용
- 빠른 분석 칩 터치 또는 직접 질문 입력
- AI가 서버에서 로드된 실제 CSV 데이터로 답변
- 답변 하단 📄 버튼으로 해당 답변 PDF 저장
- 상단 📄 버튼으로 전체 대화 PDF 저장

---

## 💬 예시 질문

**고객 분석**
- "어느 나라 고객의 이탈률이 가장 높나요?"
- "연령대별 구매 패턴을 분석해주세요"
- "VIP 고객의 특징을 알려주세요"

**이탈 예측**
- "이탈 위험이 높은 고객의 주요 특징은?"
- "장바구니 이탈률과 실제 이탈의 상관관계는?"
- "재구매를 유도하려면 어떤 전략이 좋을까요?"

**마케팅 전략**
- "이메일 캠페인 오픈율을 높이는 방법은?"
- "할인 쿠폰 전략을 어떻게 최적화할까요?"
- "모바일 앱 사용자 이탈을 줄이는 방법은?"

---

## 🔧 로컬 테스트

```bash
cd marketing-agent
npm install
node server.js
# http://localhost:3000 접속
```

---

## 📊 백엔드 API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/api/stats` | GET | 실시간 데이터 통계 (서버 상태 확인) |
| `/api/chat` | POST | Claude AI 채팅 (실제 데이터 컨텍스트) |
| `/api/query` | POST | 특정 데이터 슬라이스 조회 |

### `/api/chat` 요청 형식
```json
{
  "messages": [{"role": "user", "content": "질문"}],
  "apiKey": "sk-ant-...",
  "lang": "ko"
}
```

---

## 🔒 보안 참고사항

- API 키는 사용자 브라우저의 `localStorage`에만 저장 (서버에 저장 안 됨)
- 매 채팅 요청 시 API 키를 함께 전송 → 서버가 Claude API 호출에 사용
- HTTPS (Railway 기본 제공)로 전송 암호화
- CSV 데이터는 서버 메모리에서만 처리, 외부 노출 없음
