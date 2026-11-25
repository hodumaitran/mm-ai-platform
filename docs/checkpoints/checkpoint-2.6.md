# Checkpoint 2.6 — Prompt Management: báo cáo audit, khắc phục và nghiệm thu

Ngày: 2026-11-25

## 1. Tóm tắt điều hành

Triển khai Checkpoint 2.6 có sẵn trong working tree đã được audit, giữ lại và sửa. Bốn khiếm khuyết
mức HIGH/MEDIUM được xác nhận bằng chạy thực tế hoặc đọc mã (F01, F02, F03, F04) và đã được khắc
phục; F05 và F06 được siết chặt. Kiểm thử deterministic, nghiệm thu live với Ollama, đo hiệu năng và
hai audit lỗ hổng phụ thuộc đều **đạt**. Blocker môi trường duy nhất của lần nghiệm thu trước
(`apps/ai-service/.pytest_cache` bị từ chối truy cập, làm `prettier --check .` và `pnpm check` thất
bại) đã được xử lý trong phạm vi được ủy quyền; lệnh gộp `pnpm.cmd check` giờ có exit code 0.

## 2. Trạng thái cuối cùng

**LOCAL PASS.** Mọi tiêu chí nghiệm thu cục bộ đều có bằng chứng thực thi. Đây là nghiệm thu cục bộ
trên Windows; **Linux và CI từ xa NOT RUN**, và kết quả này không ngụ ý sẵn sàng cho production.

### 2.1 Blocker môi trường: nguyên nhân gốc và xử lý

- **Hiện tượng:** `prettier --check .` báo `EPERM: scandir apps\ai-service\.pytest_cache`; pytest
  không ghi được cache (`WinError 5`).
- **Nguyên nhân gốc:** thư mục cache do pytest sinh ra ngày 2026-11-20 có ACL/chủ sở hữu mà tài khoản
  hiện tại (`BTGROUP\Tran.ho`, thuộc Administrators nhưng token UAC bị lọc ở mức Medium) không đọc,
  không đổi ACL và không xóa được; `icacls`, `Get-Acl`, `takeown` và `Remove-Item` đều bị từ chối,
  kể cả khi chạy ngoài sandbox. Prettier vẫn quét thư mục dù đã có trong `.prettierignore`.
- **Xác minh trước khi thao tác:** đường dẫn tuyệt đối đã phân giải đúng; là thư mục thường (không
  phải junction/symlink/reparse point; cũng không có reparse point bên trong, script từ chối chạy
  nếu có); `git ls-files` trả về 0 file được track; `.gitignore:18` (`.pytest_cache/`) xác nhận
  đây là thư mục sinh tự động và bị ignore; chứa 8 mục (`.gitignore`, `CACHEDIR.TAG`, `README.md`,
  `v/cache/lastfailed`, `v/cache/nodeids` và các thư mục).
- **Xử lý (ít xâm lấn nhất):** (1) xóa thông thường thất bại (`Access denied`); (2) `takeown` và
  `icacls` ở token thường thất bại; (3) chạy một script duy nhất ở phiên nâng quyền (UAC, được ủy
  quyền) chỉ nhắm đúng đường dẫn đó: `takeown /F <thư mục> /R` (chuyển quyền sở hữu 8 mục cho
  `BTGROUP\Tran.ho`), `icacls <thư mục> /grant *<SID của chính tài khoản>:(OI)(CI)F /T` (cấp quyền
  cho chính người dùng, **không** cấp cho Everyone), rồi xóa thư mục. Không đụng thư mục cha, repo
  root, mã nguồn, hồ sơ người dùng hay lưu trữ model.
- **Thay đổi quyền:** chỉ trên thư mục đã bị xóa; sau khi xóa không còn đối tượng nào mang thay đổi đó.
- **Sau xử lý:** pytest tạo lại `.pytest_cache` với quyền bình thường (chủ sở hữu `Tran.ho`, ACL kế
  thừa: SYSTEM, Administrators, OWNER RIGHTS, người dùng); không còn cảnh báo `PytestCacheWarning`.

## 3. Baseline Git

| Mục                       | Kết quả                                                |
| ------------------------- | ------------------------------------------------------ |
| Nhánh / HEAD              | `main` / `1da9ea3763cec0304b8eb9702f23b5a0b4a26411`    |
| `checkpoint-2.5^{commit}` | `1da9ea3763cec0304b8eb9702f23b5a0b4a26411` (khớp HEAD) |
| Tag                       | không bị thay đổi; không stage, commit, push, stash    |

## 4. Đánh giá triển khai hiện có

Phần domain (định danh/phiên bản bất biến, biến có kiểu, profile, policy), registry theo
`(id, version)`, built-in và hệ thống lỗi được giữ nguyên. Kiến trúc 4 lớp được giữ: test AST
`tests/test_architecture.py` vẫn pass, domain/application không import framework. Không thêm
dependency nào.

## 5. Phát hiện theo mức độ

| ID  | Mức    | Phân loại                    | Kết luận                                                                                                                                                                     |
| --- | ------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | HIGH   | **Xác nhận bằng chạy**       | Template `{{a}} - {{b}}`, `a="{{b}}"`, `b="hello"` cho `hello - hello` (đúng ra `{{b}} - hello`).                                                                            |
| F02 | HIGH   | **Xác nhận (đọc mã + test)** | `PromptExecution` là dataclass công khai; `complete(execution)` tin object do caller dựng nên có thể bỏ qua policy, role, model và budget.                                   |
| F03 | HIGH   | **Xác nhận**                 | Quy tắc `4 + bytes/2` ước 500 chữ số là 254 token. Tokenizer tách từng chữ số (đặc tính đã biết của họ Qwen; tôi không chạy tokenizer cục bộ) cần ~500. Không phải cận trên. |
| F04 | MEDIUM | **Xác nhận**                 | `except Exception` biến mọi lỗi lập trình thành `INVALID_PROMPT_VARIABLE`.                                                                                                   |
| F05 | MEDIUM | **Xác nhận một phần**        | Registry vẫn sửa được sau khởi động; thiếu kiểm tra biến trusted bắt buộc và đồ thị khi seal. Snapshot/duplicate/mặc định tường minh vốn đã đúng.                            |
| F06 | MEDIUM | **Xác nhận**                 | Model là tham số mỗi lần gọi; profile có thể đặt giới hạn lớn hơn runtime; option bị thay thế bằng `or` thay vì kiểm tra; biến lạ trả về sai mã lỗi.                         |

Ngoài danh sách: template vai trò `assistant` được phép chứa biến untrusted (có thể giả lượt
assistant); đã chặn — chỉ vai trò `user` mới nhận biến untrusted.

## 6. Khắc phục và file bị ảnh hưởng

- **F01** — `application/prompts.py`: `PromptRenderer.render` quét template gốc đúng một lần bằng
  `PLACEHOLDER_PATTERN.finditer` và ghép giá trị; giá trị không bao giờ bị quét lại. Có kiểm tra
  giới hạn trong lúc ghép. Kết quả không phụ thuộc thứ tự khai báo.
- **F02** — `domain/prompts.py` thêm `PromptInvocation` (không có trường model, role hay giá trị
  trusted). `PromptService.complete/stream` chỉ nhận `PromptInvocation` và tự gọi `prepare` ngay
  trước gateway; `PromptExecution` chỉ để xem. Object tự dựng bị từ chối. Không dùng chữ ký mật mã.
- **F03** — `TokenEstimator` (port trung lập model), `HeuristicTokenEstimator` (mặc định, nhãn
  `ESTIMATE`, trọng số theo lớp ký tự + phụ phí khung chat) và `Utf8ByteUpperBoundEstimator` (nhãn
  `UPPER_BOUND`, chỉ chứng minh được cho tokenizer byte-level BPE/byte-fallback). `PromptBudget` có
  `BudgetAccuracy`. Không thêm tokenizer hay tải tài sản. Vượt ngân sách thì từ chối, không cắt.
- **F04** — `validate_value` ném `InvalidPromptVariableError` trực tiếp; `except Exception` bị xóa.
  Lỗi bất ngờ đi theo đường 500 chuẩn. Giá trị mặc định sai khi định nghĩa vẫn là
  `INVALID_PROMPT_TEMPLATE`; trusted default sai trong profile là `INVALID_PROMPT_PROFILE`.
- **F05** — `PromptRegistry.seal()` kiểm tra đồ thị (mỗi prompt có mặc định, profile trỏ đúng) và
  khóa mọi thay đổi (`PROMPT_REGISTRY_SEALED`). `PromptService` từ chối registry chưa seal và chỉ
  phụ thuộc giao diện chỉ đọc `PromptRepository`. Mỗi biến trusted bắt buộc phải có giá trị profile.
  `infrastructure/prompts.py` seal trước khi trả về. Không có CRUD runtime.
- **F06** — Model là đối số tin cậy của constructor (`settings.ollama_model`), `main.py` truyền vào.
  `LLMGateway.generation_defaults` (thuộc tính chỉ đọc mới trong `application/gateway.py`) là
  nguồn giới hạn runtime; giới hạn hiệu lực = `min(profile, runtime)`. Option tường minh vượt giới
  hạn bị từ chối, không bị thay thế. Biến lạ → `UNKNOWN_PROMPT_VARIABLE`, biến trusted →
  `PROMPT_POLICY_VIOLATION`. Thêm lỗi `PromptRegistrySealedError` trong `domain/errors.py`.
- **Quan sát**: `prompt.prepared` / `prompt.rejected` chỉ log `outcome`, `prompt_tokens`,
  `duration_ms`, `error_code` qua allowlist hiện có.

Tài liệu: ADR 0007, `prompt-management.md`, `prompt-security.md`, `system-overview.md`,
`technology-stack.md` (sửa mô tả Ollama đã lỗi thời), README. Báo cáo checkpoint cũ không đổi.

## 7. Quyết định kiến trúc

Execution do application sở hữu (không tin object của caller); registry "mở rồi seal" thay vì thêm
lớp quản trị; ước lượng token là cổng thay thế được với nhãn độ chính xác trung thực; giới hạn
runtime lấy từ gateway thay vì nhân đôi cấu hình provider vào định nghĩa prompt.

## 8. Xác minh bảo mật và ranh giới tin cậy

Đã kiểm chứng bằng test: chỉ system/assistant dùng biến trusted; caller không ghi đè được biến
trusted; nội dung caller (kể cả `</system>`, `system:`, `{{x}}`) luôn là đúng một message `user`;
model không đến từ caller; template giả biểu thức (`{{a+b}}`, `{{a()}}`, `{{__import__('os')}}`,
`{{ a }}`, `{{a|f}}`) bị từ chối khi tạo; log và thông điệp lỗi không chứa nội dung/biến/completion;
metadata chỉ gồm định danh và số. **Không** tuyên bố chống prompt injection ngữ nghĩa — thuộc
Checkpoint 2.9. Chưa có xác thực/RBAC; listener chỉ loopback.

## 9. Kiểm thử deterministic

| Bộ test                                | Kết quả                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Python (`pytest`, gồm test prompt mới) | **192 passed**, 9 live skipped (mặc định)                                    |
| Test prompt hiện có trước sửa          | 136 passed (lịch sử) → bộ prompt mới thu thập 66 test case (gồm tham số hóa) |
| Next.js                                | 7/7 (chạy trực tiếp, không dùng cache turbo)                                 |
| NestJS unit                            | 12/12                                                                        |
| NestJS e2e                             | 13/13                                                                        |

Test mới/được củng cố gồm: hồi quy single-pass (đã tái hiện lỗi trên mã gốc), độc lập thứ tự,
placeholder lặp, Unicode, cú pháp template sai, kiểu biến nghiêm ngặt, bắt buộc/tùy chọn, mặc định
sai, bất biến lồng nhau, vòng đời registry/seal, phiên bản lịch sử, trùng definition/profile, biến
trusted, leo thang vai trò, đối tượng execution giả, giới hạn runtime, 10 mẫu ngân sách (Anh,
Việt, CJK, emoji, dấu câu, JSON, code, chữ số, ký tự kết hợp, chữ hiếm), biên ngữ cảnh (bằng giới
hạn được nhận, +1 bị từ chối, nội dung không bị cắt), không gọi provider khi lỗi, log riêng tư,
composition root, cô lập giữa các instance, completion và streaming qua `create_app`.
Thay đổi có chủ đích với test cũ: kỳ vọng ngoại lệ của `validate_value` đổi từ
`InvalidPromptTemplateError` sang `InvalidPromptVariableError` (đúng ngữ nghĩa theo F04);
`ConservativeTokenEstimator` được đổi tên thành `HeuristicTokenEstimator` do tên cũ gây hiểu lầm.
Không có assertion nào bị nới lỏng.
Hạn chế: không có test độc lập chứng minh "fail trên mã gốc" ngoài lần tái hiện F01/F03 bằng script
trên mã gốc (mã gốc chưa được commit nên không thể checkout lại).

## 10. Nghiệm thu live (Ollama `qwen3.5:35b`, loopback, process Ollama PID 3388 giữ nguyên)

Harness tạm đặt ngoài repo, gọi `create_app(provider=ollama)`, dùng chính gateway của app.

| Hạng mục                                                   | Kết quả thực đo                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Registry built-in                                          | `general`→`general-assistant`, `research`→`research-assistant`, `document-analysis`; sealed = true                                                                                         |
| Lắp ráp + biến tiếng Việt                                  | system→user→user; biến `audience="Ban giám đốc {{b}}"` giữ nguyên `{{b}}` (single-pass); ước lượng 142 token prompt                                                                        |
| Completion qua PromptService                               | `stop`; usage 67/27/94; 0,991 s (ấm); role assistant; không có trường reasoning                                                                                                            |
| Lần đầu (nạp lạnh)                                         | ~177 s (log gateway 08:45:16 → 08:48:13), trong ngân sách 300 s                                                                                                                            |
| Streaming qua PromptService                                | 12 sự kiện (10 `ContentDelta`), `StreamStarted` đầu, đúng 1 sự kiện kết thúc ở cuối, `stop`, usage 68/11; TTFT 0,405 s; tổng 0,653 s; không có reasoning                                   |
| 8 request không hợp lệ                                     | hồ sơ lạ, ghi đè trusted, biến lạ, thiếu biến, user quá dài, output vượt giới hạn, vượt ngân sách, execution giả → tất cả bị từ chối bằng đúng mã; **0** POST `/api/chat` mới ở log Ollama |
| Chat transport hiện có (cùng gateway)                      | sync HTTP 200 (0,464 s); SSE 200 `text/event-stream`, 11 sự kiện, `stream.started`→`stream.completed`; `/ready` 200                                                                        |
| Rò rỉ                                                      | operations còn lại 0; semaphore rảnh 1; request phục hồi 0,764 s; 0 task treo                                                                                                              |
| Suite live hiện có (`AI_SERVICE_RUN_OLLAMA_INTEGRATION=1`) | **9 passed** (9,50 s)                                                                                                                                                                      |

Ước lượng 142 so với `prompt_tokens` thực 67 cho thấy heuristic thận trọng với mẫu này, nhưng đó là
một điểm dữ liệu, không phải bằng chứng cận trên. Nội dung sinh ra không được so sánh với câu cố định.
Harness live đã thất bại một lần do lỗi của chính harness (thiếu biến bắt buộc khi gọi stream) — mã
kiểm tra đã từ chối đúng; harness được sửa và chạy lại toàn bộ.

## 11. Hiệu năng chuẩn bị prompt (tách khỏi suy luận)

Môi trường: Python 3.13.14, Windows 10, Intel64 Family 6 Model 151. 2.000 lần lặp/hạng mục sau 1 lần
khởi động; `perf_counter_ns`; input ngắn 47 ký tự, dài 3.600 ký tự (tiếng Việt).

| Thao tác                   |    Trung vị |     p95 |
| -------------------------- | ----------: | ------: |
| Tra cứu profile            |      0,8 µs |  0,8 µs |
| Resolve definition         |      0,7 µs |  0,8 µs |
| Kiểm tra biến              |      0,2 µs |  0,2 µs |
| Render template            |      3,5 µs |  3,9 µs |
| Ước lượng heuristic (ngắn) |      9,4 µs |  9,8 µs |
| Ước lượng heuristic (dài)  |      324 µs |  346 µs |
| Ước lượng cận byte (dài)   |      3,9 µs |  4,1 µs |
| **`prepare` tổng (ngắn)**  | **19,4 µs** | 23,1 µs |
| **`prepare` tổng (dài)**   |  **332 µs** |  354 µs |

Hạn chế: một máy, một lần chạy, không cô lập CPU, độ phân giải đồng hồ ~0,1 µs làm các giá trị dưới
1 µs chỉ mang tính chỉ báo. Không có assertion hiệu năng trong test. So với độ trễ suy luận (0,4–177
s), chi phí chuẩn bị là không đáng kể.

## 12. Cổng chất lượng

| Cổng                                                              | Kết quả                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm.cmd exec prettier --check .` (toàn repo)                    | **PASS**, exit code 0                                                                        |
| `pnpm.cmd check` (lệnh gộp, chạy cuối cùng)                       | **PASS**, exit code 0                                                                        |
| `git diff --check`                                                | **PASS**, exit code 0 (chỉ cảnh báo thông tin LF→CRLF); file chưa track: 0 khoảng trắng thừa |
| ESLint, TypeScript                                                | **PASS** (trong `pnpm check`)                                                                |
| Web / NestJS unit / NestJS e2e                                    | **PASS** — 7/7, 12/12, 13/13                                                                 |
| Next.js và NestJS build                                           | **PASS**                                                                                     |
| `check:python` (ruff check + format, mypy strict 47 file, pytest) | **PASS** — 192 passed, 9 live skipped, không còn cảnh báo cache                              |
| `pip check`                                                       | **PASS** — không có requirement hỏng (lần chạy trước, phụ thuộc không đổi)                   |
| Quét bí mật / khóa riêng                                          | **PASS** — 1 khớp là chuỗi mẫu trong test (dương tính giả)                                   |
| Quét trọng số model / dataset / file >1 MiB                       | **PASS** — không có                                                                          |

Ghi chú: số test web 7/7 cũng đã được xác nhận bằng chạy trực tiếp `node --test` (không dùng cache
Turbo). Bằng chứng live (mục 10), hiệu năng (mục 11) và audit (mục 13) được **dùng lại** vì kể từ
các lần chạy đó **không có mã nguồn, dependency, cấu hình hay hành vi runtime nào thay đổi**: các
thay đổi sau đó chỉ gồm tài liệu/README và việc xóa cache sinh tự động.

## 13. Audit lỗ hổng phụ thuộc (chạy mới, có mạng để lấy metadata)

- Python (`scripts/audit-python.ps1`, pip-audit trên `requirements.lock`): **PASS — No known
  vulnerabilities found** (cảnh báo thông tin về hash).
- JavaScript (`pnpm audit`): **PASS — No known vulnerabilities found**.
- Không cài hay nâng cấp dependency; không gửi mã nguồn, prompt hay nội dung model.

## 14. Giới hạn còn lại và blocker

1. Không còn blocker (xem mục 2.1). Hạn chế còn lại là Prettier vẫn quét thư mục đã ignore, nên
   một thư mục cache có ACL hỏng trong tương lai có thể tái phát lỗi; cấu hình không bị thay đổi.
2. Ước lượng token là heuristic, không phải tokenizer; không có `EXACT`.
3. Phụ phí khung chat là xấp xỉ, chưa lấy từ template thực của model.
4. Admission vẫn theo process; chưa có xác thực/RBAC; không có endpoint prompt công khai (chủ ý).
5. Prompt injection ngữ nghĩa chưa được xử lý (Checkpoint 2.9).
6. Linux và CI từ xa **NOT RUN**.
7. 12 agent chuyên biệt là mục tiêu tương lai, chưa được triển khai.

Phạm vi hoãn: quản lý ngữ cảnh/hội thoại (2.7), RAG, embedding, vector DB, PostgreSQL, Redis,
LangGraph, tool calling, đa agent, workflow, API tương thích OpenAI, UI quản trị prompt, xác thực.

## 15. Dọn dẹp tài nguyên

Các tiến trình tạm của harness đã tự kết thúc (không còn tiến trình `live_2_6`); không có service
Next.js/NestJS/FastAPI được khởi động; cổng 3000/3001/8000 không có listener; Ollama PID 3388 và
`127.0.0.1:11434` giữ nguyên. Các script harness/log tạm nằm trong scratchpad ngoài repo và đã bị xóa
(script xử lý cache cũng chỉ nằm ở scratchpad). Còn một `node.exe` (PID 10420) không mở cổng nào và
không thuộc lần chạy này; không bị chạm tới. Không tải model, không đổi cấu hình toàn cục.

## 16. Trạng thái Git

HEAD `1da9ea3` và `checkpoint-2.5^{commit}` = `1da9ea3` (không đổi); không stage, commit, push, tag.
Working tree: 6 file đã sửa (`README.md`, `application/gateway.py`, `domain/errors.py`, `main.py`,
`docs/architecture/system-overview.md`, `technology-stack.md`; +87/−7 dòng) và 8 file mới chưa track
(3 module prompt, `test_prompt_management.py`, ADR 0007, 2 tài liệu kiến trúc, báo cáo này). Đã rà
diff: không có thay đổi ngoài phạm vi, không có file nhạy cảm, artifact sinh ra hay trọng số model.
Không tạo `CLAUDE.md`, không sửa `AGENTS.md`.

## 17. Khuyến nghị cho Checkpoint 2.7

Chỉ bắt đầu sau khi chủ dự án duyệt và commit/tag 2.6. Khi triển khai 2.7: dùng `usage.prompt_tokens` do provider báo để hiệu
chỉnh ước lượng, cân nhắc bộ đếm token thật qua cổng `TokenEstimator`, và đưa quản lý lịch sử vào
cùng cổng ngân sách mà không cắt âm thầm.
