# 마케팅 AI 에이전트 🤖
**Marketing AI Agent - Customer Analysis & Churn Prediction**

5만 명의 고객 데이터를 분석하는 AI 에이전트 앱.  
Claude AI(claude-sonnet-4-6) + Node.js + HTML 모바일 웹앱

---

## 📁 프로젝트 구조
```
marketing-ai-agent/
├── backend/
│   ├── server.js          # Node.js 메인 서버
│   └── package.json       # 백엔드 의존성
├── frontend/
│   └── index.html         # 모바일 UI (홈화면 + 채팅)
├── data/
│   └── customers.csv      # 5만명 고객 데이터
├── .env.example           # 환경변수 예시
├── .gitignore
├── cloudtype.yaml         # Cloudtype 배포 설정
└── package.json           # 루트 설정
```

---

## 🔐 보안 기능
| 기능 | 설정값 |
|------|--------|
| Rate Limit (채팅) | IP당 1분에 최대 20회 |
| Rate Limit (PDF) | IP당 1분에 최대 5회 |
| CORS | `ALLOWED_ORIGINS` 환경변수로 제한 |
| 입력값 제한 | 최대 500자 (백엔드 검증) |
| 대화 히스토리 | 최근 6개만 전송 (토큰 절약) |

---

## 🚀 배포 방법

### 1단계: GitHub에 업로드
```bash
# 이 폴더 전체를 GitHub 저장소로 초기화
cd marketing-ai-agent
git init
git add .
git commit -m "Initial commit: Marketing AI Agent"
git remote add origin https://github.com/[YOUR_USERNAME]/marketing-ai-agent.git
git push -u origin main
```

### 2단계: Cloudtype 배포
1. [cloudtype.io](https://cloudtype.io) 접속 → 로그인
2. **새 프로젝트** → **GitHub 연결** → 저장소 선택
3. 아래 설정 입력:
   - **런타임**: Node.js 18
   - **빌드 명령**: `cd backend && npm install`
   - **시작 명령**: `node backend/server.js`
   - **포트**: `3000`

### 3단계: 환경변수 설정 (⚠️ 중요!)
Cloudtype 대시보드 → **환경변수** 탭에서 설정:

| 키 | 값 |
|----|----|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-...` |
| `ALLOWED_ORIGINS` | `https://[앱이름].cloudtype.app` |
| `PORT` | `3000` |

### 4단계: 프론트엔드 URL 업데이트
`frontend/index.html` 파일에서 API_BASE 수정:
```javascript
// 현재 (같은 서버):
const API_BASE = '';

// Cloudtype 별도 배포인 경우:
const API_BASE = 'https://[앱이름].cloudtype.app';
```

---

## 📱 주요 기능
- **홈 화면**: 애니메이션 로봇 + 시작하기 버튼
- **고객 세분화**: LTV 기반 4단계 세그먼트 분석
- **이탈 예측**: 이탈률 패턴 및 위험 고객 식별
- **마케팅 최적화**: 채널별 효과 및 ROI 제안
- **실시간 통계**: 5만명 데이터 사전집계 표시
- **PDF 저장**: 대화 내용을 보고서로 저장
- **단계별 대화**: 20~30초 내 답변 최적화

---

## 💡 API 엔드포인트
| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/chat` | AI 채팅 (Rate: 20회/분) |
| `GET` | `/api/stats` | 데이터 통계 조회 |
| `POST` | `/api/export-pdf` | PDF 생성 (Rate: 5회/분) |
| `GET` | `/health` | 서버 상태 확인 |

---

## 🛠️ 로컬 개발
```bash
cd backend
npm install
cp ../.env.example ../.env
# .env 파일에 ANTHROPIC_API_KEY 입력
node server.js
# → http://localhost:3000
```
