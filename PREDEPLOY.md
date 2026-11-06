# 배포 직전 준비 — App9

이 문서는 배포 파일의 빌드와 검증 절차를 설명합니다. Git에 연결된 호스팅 설정에 따라 브랜치 푸시나 `main` 머지가 자동 빌드 또는 배포를 시작할 수 있으므로 실제 호스팅 계정에서 상태를 확인하세요.

## 이번 변경

월말·윤년 갱신일이 저장과 재실행을 거치면서 밀리던 문제를 원래 기준일 보존으로 수정했습니다. 예산이 0인 백업도 예산 해제를 복원하며, 구독이 없는 예산 백업도 가져옵니다. 삭제 버튼·오류 안내·다크 모드 추정 배지의 대비를 높이고, 다크 모드 삭제 버튼의 호버 글자색도 보완했습니다. 배포 구성을 추가했습니다.

공통으로 단위 테스트, 공개 파일 빌드, 로컬 링크·출력 폴더 검증, 운영 CSP를 적용한 브라우저 검사, 배포 없는 GitHub Actions 검증을 추가했습니다. `404.html`이 없는 정적 앱을 Cloudflare Pages가 SPA로 처리해 잘못된 주소에도 200을 반환하는 동작을 방지합니다.

## 다른 컴퓨터에서 재현

```sh
git clone --branch codex/predeploy-2026-11-06 https://github.com/sangsangbaksa-dev/App9.git
cd App9
npm ci
npm run check
npx playwright install chromium
npm run test:browser
```

Node.js 22 이상을 사용합니다. `npm ci`는 고정된 개발용 도구 버전을 설치합니다. 로컬 Chromium을 사용하려면 `BROWSER_EXECUTABLE_PATH`를 실행 파일 경로로 지정할 수 있습니다.

- `npm run check`: 단위 테스트 → 공개 파일 빌드 → 로컬 링크와 비공개 파일 혼입 검사.
- `npm run test:browser`: dist를 로컬 HTTP로 열고 CSP, 모바일/데스크톱, 접근성 및 앱별 주요 흐름을 확인합니다. 실제 API 호출·계정 생성·구매는 하지 않습니다.
- `FULL_AUDIT=1 npm run test:browser`: 지원 언어, 360/390/768/1280px, light/dark, 서울/뉴욕/오클랜드 시간대를 조합해 검사합니다.
- 결과: `artifacts/browser/<engine>/report.json`, 스크린샷. 이 폴더와 `dist/`는 Git에 포함하지 않습니다.

## 배포 파일

`npm run build`로 만든 `dist/`가 최종 정적 배포 파일입니다. 서버 함수나 별도 API 키는 필요하지 않습니다. 저장된 데이터는 브라우저 localStorage에 있으므로 배포 주소가 달라지면 자동으로 옮겨지지 않습니다. 기존 주소에서 JSON 백업 후 새 주소에서 복원하세요.

GitHub Actions의 **Verify deployment bundle**은 테스트와 파일 생성만 수행합니다. Cloudflare 인증 정보를 읽지 않으며 배포 단계가 없습니다. Actions 결과물은 14일간 보관됩니다. 

## 실제 배포 전에 남은 확인

- 대상 Cloudflare 계정과 Pages 프로젝트, 연결할 도메인·주소를 소유자가 확인해야 합니다. 토큰이나 계정 ID를 코드에 넣지 마세요.
- 이번 검증은 로컬 환경과 고정된 테스트 데이터 기준입니다. 프로덕션 사용자 데이터, 실제 계정 인증, 실제 구매·환불을 검증한 것은 아닙니다.

## 브라우저 엔진 검증

기본 `npm run test:browser`는 Chromium으로 실행합니다. `npx playwright install firefox webkit`과 해당 OS 종속성을 준비한 뒤 `BROWSER_ENGINE=firefox npm run test:browser` 또는 `BROWSER_ENGINE=webkit npm run test:browser`로 같은 회귀 흐름을 검사합니다. 결과는 `artifacts/browser/<engine>/`에 저장됩니다. WebKit은 Safari 및 실제 iOS 기기 검증을 대신하지 않습니다. 클립보드 권한 자동 허용은 Chromium에서만 사용하므로 다른 엔진의 모든 클립보드 동작을 검증했다고 해석하지 마세요.

WebKit 검사는 CSP 오류의 원인이 되는 Playwright의 임시 스크린샷 스타일 삽입을 피하기 위해 스크린샷을 생략합니다. 접근성·레이아웃·기능 검사는 그대로 실행하며 보안 정책 오류를 무시하지 않습니다. 화면 캡처는 Chromium·Firefox 결과를 사용합니다.
