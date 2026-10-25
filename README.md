# Codex Flow Viewer

Codex 로컬 기록과 데스크톱 MCP로 전달받은 질문·답변을 타임라인으로 보는 로컬 웹 앱입니다. 기존 Tom & Jerry 화면 디자인과 작업 보기·한눈에 보기·검색·고정·메모를 포함합니다.

**Windows / Node.js 24.18 이상**을 기준으로 합니다. 설치·빌드 시 인터넷이 필요합니다. 이 저장소에는 개인 대화, Codex 원본 로그, 저장 DB, 로그인 정보가 포함되지 않습니다.

## 1. 다운로드와 실행

Git을 사용하는 경우 CMD에서 실행합니다.

```bat
git clone https://github.com/Unknown02-coder/viewer.git
cd viewer\codex-flow-viewer
node --version
npm.cmd ci
npm.cmd run build
start-viewer.cmd
```

Git이 없으면 GitHub의 **Code → Download ZIP**으로 받은 뒤 압축을 풀고, 안의 `codex-flow-viewer` 폴더에서 명령을 실행합니다. CMD에서 경로 이동 시 `cd /d "실제 폴더 경로"`처럼 큰따옴표를 사용합니다.

이후에는 `codex-flow-viewer/start-viewer.cmd`를 더블클릭하면 됩니다. 새 서버가 실행된 창은 사용 중에 닫지 마세요. 이미 실행 중이라는 안내창은 기존 서버를 종료하지 않습니다.

브라우저 주소: **http://127.0.0.1:4318**

현재 컴퓨터 시작 시 자동 실행·서버 자동 복구·다중 PC 동기화 기능은 없습니다. 소스 업데이트 후에는 `npm.cmd ci`와 `npm.cmd run build`를 다시 실행하고 서버를 재시작합니다.

## 2. Codex 로컬 기록 보기

1. 뷰어의 **설정 → Codex 프로젝트**를 엽니다.
2. 프로젝트 폴더에 해당 컴퓨터의 실제 작업 폴더를 입력합니다.
3. 기록 위치에 보통 `C:\Users\사용자\.codex\sessions`를 입력합니다. `CODEX_HOME`을 따로 설정했다면 그 위치를 사용합니다.
4. **프로젝트 연결**을 누릅니다. 기록에서 확인된 정확한 프로젝트 목록을 이용할 수도 있습니다.

프로젝트 경로에 일치하는 기록만 표시합니다. ChatGPT 채팅 제목은 프로젝트 폴더가 아닙니다. 이 기능만 사용할 때는 MCP 등록이나 뷰어용 API 키가 필요하지 않습니다. JSONL과 JSONL.ZST, 보관 기록을 읽으며 원본을 수정하거나 그 안의 명령을 실행하지 않습니다.

## 3. 데스크톱 채팅 → MCP → 뷰어 연결

로컬 MCP를 지원하는 데스크톱 실행 환경이 필요합니다. 현재 PC의 실제 모델 호출·저장·화면 반영은 확인했지만, 다른 PC의 앱 버전·계정·실행 모드는 설치 후 확인해야 합니다.

앱 폴더를 예를 들어 `C:\Tools\viewer\codex-flow-viewer`에 설치했다면 다음과 같이 등록합니다. **실제 Node 및 프로그램 절대경로로 바꾸세요.**

```bat
codex mcp add flow-viewer -- "C:\Program Files\nodejs\node.exe" "C:\Tools\viewer\codex-flow-viewer\server\mcp\stdio.mjs"
codex mcp list
```

`codex` 명령이 없을 때의 설정 파일 등록 방법은 [상세 매뉴얼](codex-flow-viewer/docs/other-computer-manual.ko.md)에 있습니다. 이미 등록된 경우 같은 항목의 실행 경로를 확인합니다. [OpenAI 공식 MCP 설정 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

1. 데스크톱 설정 → **플러그인 → MCP → flow-viewer**를 활성화합니다. 메뉴와 로컬 도구 지원 여부는 사용하는 환경에서 확인합니다.
2. `flow_status`, `flow_list_projects`, `flow_create_project`, `flow_start_conversation`, `flow_record`의 5개 도구가 보이는지 확인합니다.
3. 해당 채팅에 **“flow-viewer의 flow_status 도구를 호출해서 연결 상태를 확인해줘.”**라고 요청합니다. 실제 응답의 `status=ready`, `recordingAvailable=true`를 확인합니다.
4. 뷰어 **설정 → ChatGPT 대화**에서 프로젝트를 만들거나 선택하고 **프로젝트 열기**를 누릅니다.
5. **ChatGPT에서 사용할 연결 문구**를 복사해 도구가 보이는 채팅에 붙여넣고 질문·답변 하나를 전송합니다.
6. 저장 영수증과 뷰어의 대화 목록·본문을 확인합니다. 정상 실행 중에는 약 2초 간격으로 갱신합니다.

MCP는 **실제 도구로 보낸 내용만** 저장합니다. 전체 계정의 과거 채팅 조회나 모든 답변의 자동 전송을 보장하지 않습니다. MCP 수신기는 데스크톱 호스트가 시작하며 뷰어 화면 서버도 별도로 실행해야 합니다. `http://127.0.0.1:4318`은 화면 주소이며 STDIO MCP 등록 URL이 아닙니다.

## 4. 다른 컴퓨터로 기존 기록 옮기기

앱 내부 DB는 `codex-flow-viewer/.local/viewer.sqlite`입니다. 질문·답변 수신 기록과 메모·고정·설정을 저장합니다. **Git clone에는 개인 DB가 포함되지 않습니다.**

뷰어 서버와 flow-viewer MCP를 모두 종료한 다음 `.local` 폴더를 백업해 새 PC의 같은 앱 하위 위치에 복사합니다. 새 PC에 이미 기록이 있다면 먼저 별도 백업하며, 자동 병합하거나 기존 DB를 덮어쓰지 않습니다. SQLite 보조 파일을 포함한 중지 상태의 일관된 백업을 사용합니다. 원본 Codex 로그는 DB에 포함되지 않으므로 별도 준비가 필요합니다.

새 PC에서는 MCP 실행 경로와 Codex 프로젝트·기록 경로를 다시 확인합니다. 옛 PC 로그의 프로젝트 경로와 새 PC 경로가 다르면 자동 연결되지 않을 수 있으며 임의 경로 매핑은 구현하지 않았습니다. 같은 계정 로그인으로 DB가 동기화되지 않습니다. 각 PC에서 별도 로컬 DB를 사용하세요.

## 5. 안 보이거나 연결되지 않을 때

| 증상 | 확인 |
|---|---|
| 브라우저 연결 거부 | start-viewer.cmd를 실행하고 서버 창 유지 |
| MCP 정상인데 화면이 열리지 않음 | MCP와 화면 서버는 별개이므로 뷰어도 실행 |
| 다른 프로젝트 대화만 보임 | 설정에서 출처와 정확한 프로젝트를 열기 |
| 새 설치에 대화가 없음 | 빈 DB가 기본. Codex 기록 연결 또는 실제 MCP 전송 필요 |
| 저장됐는데 목록에 없음 | MCP와 뷰어가 같은 앱 폴더·VIEWER_DB를 사용하는지, 검색·필터 상태 확인 |
| flow_status만 보임 | 최신 서버 경로 확인 후 MCP 연결 갱신·앱 재시작, 실제 5개 도구 확인 |
| 폴더가 있는데 Codex 대화 0개 | 로그에 기록된 프로젝트 경로와 실제 폴더가 일치하는지 확인 |

## 6. 개발 검증

앱 폴더에서 실행합니다.

```bat
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:browser
```

브라우저 테스트는 설치된 Microsoft Edge를 사용합니다. 합성 fixture와 격리된 DB를 사용하며 사용자 원본 기록은 시험 입력으로 복사하지 않습니다. 과거 사본 기능의 코드는 회귀 검증을 위해 일부 남아 있지만 현재 제품의 가져오기 화면·런타임 API로 활성화하지 않습니다.

## 폴더 구성

```text
README.md / READ.md                설치 안내
codex-flow-viewer/
  src/                            React 화면
  server/                         기록 읽기·HTTP·SQLite·MCP
  scripts/                        실행 도우미
  public/artwork/                 현재 화면에 필요한 이미지
  tests/                          합성 입력 기반 검증
  docs/other-computer-manual.ko.md  상세 이전·설치 매뉴얼
  package.json / package-lock.json 의존성과 실행 명령
  start-viewer.cmd                 Windows 실행
```

표시되는 파일 변경·diff·실행 결과는 근거가 있는 내용만 사용합니다. 받은 본문·요약·사용자 메모는 구분합니다. 포함된 캐릭터 이미지가 별도의 캐릭터 권리 허락을 의미하지는 않습니다.
