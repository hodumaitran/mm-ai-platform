# Checkpoint 2.7 — Context Management: báo cáo triển khai và nghiệm thu

Ngày: 2026-11-25

Quy ước nhãn: **[Nguồn]** = sự thật xác minh từ mã/Git; **[Chạy]** = kết quả thực thi trong lần này;
**[Lịch sử]** = bằng chứng từ báo cáo cũ; **[Giả định]** = suy luận chưa kiểm chứng.

## 1. Tóm tắt điều hành

Đã triển khai hệ thống quản lý ngữ cảnh trung lập model, bất biến và xác định (deterministic) bên trong
AI service: hợp đồng domain cho hội thoại/nguồn/ngân sách/lựa chọn, `ContextService` ở lớp application,
tái sử dụng `PromptService` (qua `resolve()` mới tách ra) và `TokenEstimator` của 2.6, và chỉ thực thi
qua `LLMGateway` hiện có. Không thêm endpoint công khai, dependency, kho lưu trữ hay hạ tầng. Toàn bộ
test deterministic, nghiệm thu live với Ollama `qwen3.5:35b`, đo hiệu năng, quality gate và hai audit
phụ thuộc đều đạt.

## 2. Trạng thái cuối cùng

**LOCAL PASS.** Đây là nghiệm thu cục bộ trên Windows, không phải phê duyệt production. **Linux và CI
từ xa: NOT RUN.** Cô lập ngữ cảnh chỉ là cô lập cấu trúc, không phải cô lập tenant (chưa có xác thực).

## 3. Baseline Git

| Mục                        | Kết quả [Chạy]                                                               |
| -------------------------- | ---------------------------------------------------------------------------- |
| Nhánh / HEAD               | `main` / `3182e67` (`feat(ai-core): implement enterprise prompt management`) |
| `checkpoint-2.6^{commit}`  | `3182e6705184585e7e57dbc813ecca51478fd1fc` = HEAD                            |
| `checkpoint-2.5^{commit}`  | `1da9ea3763cec0304b8eb9702f23b5a0b4a26411` (không đổi)                       |
| Đồng bộ remote             | `git branch -vv`: `main` không lệch `origin/main` (không có ahead/behind)    |
| Working tree trước khi sửa | sạch; không có stash                                                         |

Không reset, clean, stash, stage, commit, push hay đổi tag.

## 4. Đánh giá triển khai hiện có [Nguồn]

Có thể tái sử dụng: `PromptService` (profile/rendering/giới hạn runtime đã kiểm chứng), cổng
`TokenEstimator` + `BudgetAccuracy`, `LLMGateway.generation_defaults`, bộ logger có allowlist, kiểm thử
kiến trúc bằng AST, lỗi `ServiceError` có mã ổn định. Ràng buộc tích hợp: `PromptService.prepare` gộp
validation và kiểm ngân sách trong một hàm nên không thể chèn lịch sử mà không nhân đôi logic; xử lý
bằng cách tách `resolve()` (không đổi hành vi). Rủi ro: lịch sử do caller cung cấp có thể bị giả mạo
khi chưa có xác thực; ước lượng token chỉ là heuristic.

## 5. Quyết định kiến trúc

Xem [ADR 0008](../adr/0008-context-management.md). Tóm tắt: (1) **không lưu trạng thái** — snapshot
bất biến do caller truyền vào, nên không có store, vòng đời hay trạng thái chung; (2) **trust do nguồn
quyết định**, cố định trong `SOURCE_TRUST`, không nhận từ caller; (3) **một estimator duy nhất** (của
`PromptService`), không thêm estimator cạnh tranh; (4) **đối tượng thực thi duy nhất là
`ContextInvocation`**, kết quả lắp ráp chỉ để xem; (5) tách `PromptService.resolve()` để dùng chung
validation. Không có tầng infrastructure và presentation mới (có lý do: không cần store, không route).

## 6. File tạo và sửa

Tạo: `domain/context.py` (400 dòng), `application/context.py` (359), `tests/test_context_management.py`
(1.009), ADR 0008, `context-management.md`, `context-budget-policy.md`, `context-security.md`,
báo cáo này.
Sửa: `application/prompts.py` (tách `resolve()`, `ResolvedPrompt`, thuộc tính `estimator`/
`model_identifier`), `domain/errors.py` (+5 lỗi), `infrastructure/logging.py` (+8 khóa allowlist),
`main.py` (lắp `ContextService`), `README.md`, `system-overview.md`, `logging-privacy-policy.md`.
Tổng: 7 file sửa (+111/−11 dòng), 8 file mới. Không sửa `AGENTS.md`, không tạo `CLAUDE.md`.

## 7. Hợp đồng domain

`ConversationIdentifier`, `ContextIdentifier` (≤64 ký tự), `ConversationTurn`, `ConversationSnapshot`,
`ReferenceMaterial`, `ContextInvocation`, `ContextSource`, `ContextTrust`, `ContextItem`,
`ContextSelectionPolicy`, `ExclusionReason`, `ExcludedContext`, `ContextSelectionResult`,
`ContextBudget`, `ContextExecutionMetadata`, `ContextAssemblyResult`. Tất cả là dataclass frozen,
collection lồng nhau là tuple (đầu vào list được sao chép), mọi giá trị được kiểm giới hạn; không có
dict metadata tùy ý. Dùng lại `ChatMessage`/`CompletionRequest`, không nhân bản hợp đồng LLM.

## 8. Quản lý lịch sử hội thoại

Đơn vị là **lượt hoàn chỉnh** (user + assistant): không thể biểu diễn một assistant thiếu user. Snapshot
yêu cầu `sequence` tăng nghiêm ngặt, mọi lượt thuộc cùng hội thoại, ≤64 lượt, ≤8.192 ký tự/tin,
≤65.536 ký tự tổng. `from_messages` từ chối chuỗi không xen kẽ user/assistant, vai trò system/tool,
tin lẻ. Lịch sử rỗng hợp lệ. Không có kho lưu trữ hay CRUD.

## 9. Phân loại nguồn ngữ cảnh

| Nguồn                  | Trust     | Ghi chú                                                                |
| ---------------------- | --------- | ---------------------------------------------------------------------- |
| `trusted_prompt`       | trusted   | Template server chỉ chứa biến trusted                                  |
| `current_request`      | untrusted | Gồm cả tin nhắn prompt chứa biến untrusted (không bị gắn nhãn trusted) |
| `conversation_history` | untrusted | Vai trò assistant không làm nó đáng tin                                |
| `reference_material`   | untrusted | Bọc khung "untrusted data, not instructions", vai trò `user`           |

Chỉ item `trusted_prompt` được mang vai trò `system` (kiểm ở `ContextItem` và lần kiểm sau lắp ráp).

## 10. Cô lập và ranh giới bảo mật

Đã kiểm chứng bằng test: lượt của hội thoại khác bị từ chối; hai yêu cầu đồng thời của hai hội thoại
không lẫn nội dung; mỗi instance `create_app` có `ContextService`/`PromptService`/gateway riêng;
`ContextService` không giữ trạng thái (`vars()` chỉ gồm `_prompts`, `_policy`, `_logger`); nội dung
hostile (`</system>`, `system:`, `{{...}}`) luôn là đúng vai trò theo vị trí; đối tượng giả
(`ContextAssemblyResult`, `CompletionRequest`, `PromptInvocation`, chuỗi) bị từ chối với
`CONTEXT_POLICY_VIOLATION` và provider không được gọi; id tham chiếu trùng id dành riêng bị từ chối;
log/lỗi không chứa nội dung hay id hội thoại. **Giới hạn:** không có xác thực nên lịch sử có thể bị giả
mạo, và cô lập này **không** là cô lập tenant. Prompt injection ngữ nghĩa là rủi ro tồn dư, hoãn sang
2.9; khung phân tách dữ liệu không ngăn model làm theo chỉ dẫn trong tài liệu.

## 11. Ước lượng token

Dùng lại `TokenEstimator` của 2.6 (mặc định `HeuristicTokenEstimator`, nhãn `ESTIMATE`; tùy chọn
`Utf8ByteUpperBoundEstimator`, nhãn `UPPER_BOUND`, chỉ chứng minh được cho tokenizer byte-level).
Chi phí từng tin = `estimate((m,),0) − estimate((),0)`; tổng marginal lớn hơn ước lượng cả danh sách
tối đa 1 token/tin (phía thận trọng) — được kiểm bằng test trên 9 mẫu (Anh, Việt, CJK, emoji, code, JSON,
dấu câu, hỗn hợp, văn bản dài) × 2 estimator. Mỗi tin chỉ được ước lượng một lần mỗi lần chuẩn bị
(test đếm số lần gọi). Không tải tokenizer, không dịch vụ ngoài. Không gọi heuristic là cận trên.

## 12. Phân bổ ngân sách

`mandatory + history + reference + output + margin ≤ giới hạn hiệu lực`, trong đó giới hạn hiệu lực =
`min(profile, cửa sổ ngữ cảnh của gateway, context_window tường minh)` (cấu hình đã duyệt 4.096, không
phải mức tối đa của model). Output (đã gồm token suy luận khi bật thinking) được giữ chỗ trước; margin
mặc định 128. `ContextBudget` từ chối số âm hoặc vượt giới hạn. Option tường minh vượt giới hạn bị từ
chối (không bị sửa im lặng).

## 13. Chọn lọc ngữ cảnh

Thứ tự ưu tiên: prompt tin cậy → yêu cầu hiện tại → lịch sử (mới nhất trước, nguyên lượt, dừng ở lượt
đầu tiên không vừa để không có khoảng trống) → tài liệu tham chiếu (theo thứ tự caller, first-fit).
Thứ tự cuối: prompt → lịch sử (cũ→mới) → tham chiếu → yêu cầu hiện tại. Kết quả liệt kê id được giữ và
bị loại kèm lý do (`turn_limit`, `item_limit`, `token_budget`) và chi phí ước lượng. Không cắt ký tự,
không xếp hạng ngữ nghĩa/embedding/LLM. Điều chỉnh so với gợi ý: tài liệu tham chiếu được đặt ngay
trước yêu cầu hiện tại thay vì sau lịch sử trong cùng khối, để gần câu hỏi nhất.

## 14. Bảo vệ tràn ngữ cảnh

Nội dung bắt buộc không vừa → `CONTEXT_BUDGET_EXCEEDED` (422) trước khi gọi provider; không cắt. Lỗi
có kiểu: `INVALID_CONVERSATION`, `INVALID_CONTEXT_ITEM`, `INVALID_CONTEXT_POLICY`,
`CONTEXT_POLICY_VIOLATION`, cùng các lỗi `PROMPT_*` cũ. Thông điệp công khai không chứa nội dung.

## 15. Tích hợp Prompt Management

Giữ nguyên: định danh/phiên bản, registry đã seal, render một lượt, validate biến, ranh giới trusted,
policy profile, model tin cậy, và việc `PromptService.complete/stream` chỉ nhận `PromptInvocation`.
`resolve()` là phần tách thuần túy; toàn bộ 192 test cũ vẫn pass sau refactor. `ContextService` không
tái tạo lỗ hổng `PromptExecution` giả vì không chấp nhận bất kỳ đối tượng thực thi nào do caller dựng.

## 16. Tích hợp Gateway

Mọi suy luận đi qua `LLMGateway`; không retry, không fallback, không gọi Ollama trực tiếp. `timeout_seconds`
tùy chọn được chuyển nguyên cho gateway và vẫn bị chặn trên bởi timeout của gateway. **Đính chính
(xem mục 28.3):** chuẩn bị ngữ cảnh chạy _trước_ khi gateway bắt đầu tính deadline, nên thời gian chuẩn bị
nằm **ngoài** deadline có thẩm quyền chứ không được tính vào đó (phát biểu ban đầu "không kéo dài
deadline" chỉ đúng theo nghĩa nó không làm gateway nới deadline). Test xác nhận: admission 1 active + 1 pending
(yêu cầu thứ ba nhận `ProviderOverloadError`, yêu cầu pending không bao giờ tới provider), hủy tác vụ
giải phóng capacity, deadline `RequestDeadlineExceededError`.

## 17. Kết quả test deterministic [Chạy]

| Bộ test                                  | Kết quả                                      |
| ---------------------------------------- | -------------------------------------------- |
| Python (`pytest`)                        | **280 passed**, 9 live skipped               |
| — trong đó test context mới              | 88 (gồm tham số hóa)                         |
| — 192 test của 2.6 (không đổi/không nới) | pass                                         |
| Next.js                                  | 7/7                                          |
| NestJS unit / e2e                        | 12/12 / 13/13                                |
| **Tổng deterministic phân biệt**         | **312** (280 + 7 + 12 + 13), không đếm trùng |
| Suite live Ollama hiện có                | **9 passed** (10,22 s), tách riêng           |

Bao phủ: hợp đồng (định danh, vai trò, nguồn, kích thước), lịch sử (rỗng, nhiều lượt, thứ tự, trùng,
sai chuỗi vai trò, giới hạn, giữ nguyên lượt), cô lập/bảo mật (chéo hội thoại, đồng thời, instance,
nâng quyền, trust do caller, đối tượng giả, log, lỗi), ngân sách/chọn lọc (rỗng, biên chính xác, tràn
bắt buộc, giữ chỗ output, margin, giới hạn runtime, loại tùy chọn, tính xác định, Unicode, không cắt
nội dung bắt buộc), tích hợp (PromptService, gateway, provider không bị gọi khi lỗi, completion,
streaming, hủy, deadline, admission, health/ready, kiểm tra kiến trúc).

## 18. Bằng chứng live [Chạy] (Ollama `qwen3.5:35b`, loopback, dữ liệu tổng hợp)

| Kịch bản                                   | Kết quả                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hội thoại tiếng Việt nhiều lượt (nạp lạnh) | 177,2 s; `stop`; usage 105/12/117; câu trả lời nhắc đúng "Minh" và "Đà Nẵng"                                                                             |
| Hội thoại tiếng Anh nhiều lượt             | 0,565 s; `stop`; trả lời "Biscuit"; usage 69/4                                                                                                           |
| Lắp ráp tin nhắn                           | vai trò `system,user,assistant,user,assistant,user`; nhãn trust: 1 trusted_prompt, 4 history, 1 current (đều untrusted)                                  |
| Streaming có ngữ cảnh                      | 13 sự kiện (11 `ContentDelta`), `StreamStarted` đầu, **1** sự kiện kết thúc ở cuối, `stop`, usage 102/12, TTFT 0,514 s, tổng 0,777 s, không có reasoning |
| Tài liệu tham chiếu                        | vai trò `system,user,user`; trả lời đúng mã "ALPHA-731"                                                                                                  |
| Chọn lọc dưới ngân sách ràng buộc          | ngữ cảnh 700: giữ `turn-5`, `turn-6`; loại `turn-1…4` (`token_budget`); trả lời đúng "6"                                                                 |
| Tràn bắt buộc                              | `CONTEXT_BUDGET_EXCEEDED`; **0** POST `/api/chat` mới                                                                                                    |
| Cô lập hai hội thoại (chạy đồng thời)      | A trả lời "Minh", không có "Lan"; B trả lời "Lan", không có "Minh"; request không chứa dữ liệu chéo                                                      |
| Chat transport hiện có                     | sync 200; SSE 200 `text/event-stream`, 14 sự kiện, `stream.started`→`stream.completed`; `/ready` 200                                                     |
| Rò rỉ tài nguyên                           | operations còn lại 0; semaphore rảnh 1; request phục hồi 0,423 s; 0 task treo                                                                            |

Ghi chú trung thực: lần chạy đầu của kịch bản "ngân sách ràng buộc" dùng ngữ cảnh 256 quá chặt nên loại
cả 6 lượt (đúng hành vi nhưng chưa minh họa việc giữ một phần); tôi chạy lại riêng với ngữ cảnh 700 và
báo kết quả trên. Các tiêu chí được đánh giá khách quan (chuỗi chứa tên/mã, cấu trúc sự kiện); một mẫu
tổng hợp nhỏ **không** là bằng chứng về độ chính xác tổng quát của model.

## 19. Ước lượng so với token do provider báo [Chạy]

14 yêu cầu (n nhỏ). `estimated / observed` (observed = `usage.prompt_tokens`, đã gồm khung chat của model):
trong khoảng **1,44–2,23** (trung bình ≈1,9); yêu cầu ngân sách ràng buộc 521/226 ≈ 2,3. Nhỏ nhất ở mẫu
chữ số (1,44); lớn nhất ở CJK (2,23). Mọi mẫu đều **không thấp hơn** số thực. **Không** suy ra đây là cận
trên: mẫu nhỏ, một tokenizer, không có đầu vào đối kháng (chuỗi định danh ngẫu nhiên, chữ hiếm). Hệ quả:
heuristic dùng ~1,4–2,3 lần ngữ cảnh thật, tức là thận trọng (có thể loại bỏ lịch sử hơn mức cần).
Không thay đổi policy dựa trên mẫu này.

## 20. Hiệu năng chuẩn bị ngữ cảnh [Chạy]

Môi trường: Python 3.13.14, Windows 10, Intel64 Family 6 Model 151; 1.000 lần lặp sau 1 lần khởi động;
`perf_counter_ns`; heuristic mặc định, ngữ cảnh 4.096, output 256, margin 128, tối đa 16 lượt/4 tham chiếu.

| Workload (lượt × ký tự; tham chiếu × ký tự) | Ký tự vào | Token ước lượng | Item | Lịch sử giữ/loại | Tham chiếu giữ/loại | Trung vị |      p95 |
| ------------------------------------------- | --------: | --------------: | ---: | ---------------: | ------------------: | -------: | -------: |
| không lịch sử                               |         0 |              65 |    2 |              0/0 |                 0/0 |  40,3 µs |  46,1 µs |
| 8 × 120                                     |     1.920 |           1.401 |   18 |              8/0 |                 0/0 | 320,1 µs | 343,8 µs |
| 16 × 200                                    |     6.400 |           3.549 |   28 |             13/3 |                 0/0 | 821,1 µs | 879,4 µs |
| 64 × 200 (đạt giới hạn ngân sách tại 13)    |    25.600 |           3.549 |   28 |            13/51 |                 0/0 |  3,07 ms |  3,23 ms |
| 64 × 500 (ngân sách)                        |    64.000 |           3.295 |   12 |             5/59 |                 0/0 |  6,47 ms |  6,81 ms |
| 8 × 120 + 4 × 1.500                         |     7.920 |           3.413 |   20 |              8/0 |                 2/2 | 925,8 µs | 992,8 µs |
| 16 × 200 + 8 × 4.000                        |    38.400 |           3.549 |   28 |             13/3 |                 0/8 |  3,91 ms |  4,13 ms |

Estimator cận byte (16 × 200): trung vị 236 µs, p95 257 µs; giữ 6 lượt, loại 10 (bi quan hơn). Chi phí
chuẩn bị tối đa đo được ≈ 6,5 ms, nhỏ hơn nhiều so với suy luận (0,4–177 s). Giới hạn: một máy, một
lần chạy, không cô lập CPU; thời gian tỉ lệ tuyến tính theo số ký tự của snapshot (bị chặn ở 65.536) vì
chi phí của cả lượt bị loại cũng được ước lượng để báo cáo. Không có assertion hiệu năng trong test.

## 21. Quality gate [Chạy]

| Cổng                                              | Kết quả                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm.cmd check` (lệnh gộp, chạy cuối cùng)       | **PASS**, exit code 0                                                                        |
| Prettier toàn repo (nằm trong `pnpm check`)       | **PASS** ("All matched files use Prettier code style!")                                      |
| ESLint, TypeScript, build Next.js/NestJS          | **PASS** (trong `pnpm check`)                                                                |
| Ruff lint + format, mypy strict (50 file), pytest | **PASS** (280 passed, 9 skipped)                                                             |
| `pip check`                                       | **PASS** — không có requirement hỏng                                                         |
| `git diff --check`                                | **PASS**, exit code 0 (chỉ cảnh báo LF→CRLF thông tin); file chưa track: 0 khoảng trắng thừa |
| Quét bí mật / khóa riêng                          | **PASS** — chạy lại ở mục 28.1 với mã thoát phân biệt (lần đầu rc=123 chưa đủ bằng chứng)    |
| Quét trọng số model / dataset / file >1 MiB       | **PASS** — không có                                                                          |

Không đổi quyền hệ thống hay cấu hình cổng. Thư mục `.pytest_cache` được tạo lại bình thường; blocker ACL
của 2.6 không tái phát.

## 22. Audit lỗ hổng phụ thuộc [Chạy, chạy mới]

- Python (`scripts/audit-python.ps1`, pip-audit trên `requirements.lock`): **PASS — No known vulnerabilities found**.
- JavaScript (`pnpm audit`): **PASS — No known vulnerabilities found**.
- Không cài/nâng cấp dependency, không thay `pyproject.toml`/lockfile; không gửi mã nguồn, prompt hay nội dung model.

## 23. Khiếm khuyết phát hiện và đã khắc phục

Không phát hiện lỗi mới trong baseline 2.6. Các vấn đề được bắt trong lúc phát triển (trước khi hoàn tất):

1. Khi dừng chọn lịch sử vì `TURN_LIMIT`, các lượt cũ hơn lúc đầu bị gán nhầm lý do `TOKEN_BUDGET`;
   sửa để giữ nguyên nguyên nhân dừng (có test).
2. Tin nhắn prompt (vai trò user) có biến untrusted bị gắn nhãn `trusted_prompt`; sửa thành
   `current_request`/untrusted theo biến được khai báo (có test).
3. Id tài liệu tham chiếu có thể trùng id dành riêng (`current`, `prompt-0`, `turn-*`); nay bị từ chối
   trước provider (có test tham số hóa).
4. Một số lỗi của chính test/harness (độ dài chuỗi, profile tên sai, workload vượt giới hạn domain —
   domain từ chối đúng) đã được sửa; không nới lỏng assertion nào.

## 24. Giới hạn còn lại và nợ kỹ thuật

- Thời gian chuẩn bị ngữ cảnh nằm ngoài deadline của gateway (mục 28.3): tổng thời gian chờ thực tế là
  `chuẩn bị + deadline gateway`. Với estimator mặc định chuẩn bị tối đa đo được ≈ 6,5 ms; với estimator
  tùy biến chậm thì không bị chặn. **Đã khắc phục ở mục 29** (phát hiện này ban đầu chưa được sửa).
- Lịch sử do caller cung cấp có thể bị giả mạo; chưa có xác thực/RBAC/ownership → không phải cô lập tenant.
- Prompt injection ngữ nghĩa chưa được xử lý (2.9); khung "untrusted data" chỉ là biện pháp cấu trúc.
- Ước lượng token là heuristic (≈1,4–2,3× so với quan sát trên mẫu nhỏ); khung chat là xấp xỉ; chưa có
  đếm token chính xác. Cận byte quá bi quan để làm mặc định.
- Giả định cộng tính của estimator là hợp đồng không được cưỡng chế bằng kiểu; estimator không cộng tính
  sẽ cho chi phí marginal sai (được test cho hai estimator đi kèm).
- Chi phí chuẩn bị tỉ lệ theo kích thước snapshot (≤ ~6,5 ms ở giới hạn trên); chưa có cache giữa các yêu cầu.
- Chưa có kho lưu hội thoại, truy xuất, tóm tắt, tool calling; admission vẫn theo process.
- Ngân sách mặc định 4.096 token (cấu hình đã duyệt), không phải cửa sổ tối đa của model.
- Linux và CI từ xa: **NOT RUN**.

## 25. Dọn dẹp tài nguyên

Các harness và script đo tạm nằm ở scratchpad ngoài repo và đã bị xóa; không còn tiến trình Python tạm;
không có service Next.js/NestJS/FastAPI được khởi động; cổng 3000/3001/8000 không có listener. Ollama
PID 3388 (`127.0.0.1:11434`) giữ nguyên. Không tải model, không đổi cấu hình toàn cục hay quyền.

## 26. Trạng thái Git

HEAD `3182e67` = `checkpoint-2.6^{commit}`; không stage, commit, push, tag. Working tree: 7 file đã sửa
(`README.md`, `application/prompts.py`, `domain/errors.py`, `infrastructure/logging.py`, `main.py`,
`system-overview.md`, `logging-privacy-policy.md`) và 8 file mới chưa track (2 module context, 1 file
test, ADR 0008, 3 tài liệu kiến trúc, báo cáo này). Đã rà diff: không có thay đổi ngoài phạm vi, file
nhạy cảm, artifact sinh ra hay trọng số model.

## 27. Mức sẵn sàng cho Checkpoint 2.8 (Tool Calling)

Sẵn sàng về mặt nền tảng: ngữ cảnh có nguồn/trust tường minh và một đường thực thi duy nhất qua gateway.
Tiền đề cần giữ khi làm 2.8: vai trò `tool` hiện bị từ chối ở `ContextItem` và `ConversationSnapshot`
(cố ý), nên cần mở rộng hợp đồng có kiểm soát; kết quả tool phải được phân loại untrusted theo nguồn;
và cần quyết định cách tính ngân sách cho lược đồ tool. Chủ dự án cần duyệt rồi commit/tag 2.7 trước khi
bắt đầu.

## 28. Xác minh cuối và hotfix CI [Chạy]

### 28.1 Quét bí mật (chạy lại, phân biệt kết quả với lỗi thực thi)

Lần trước báo `rc=123`: đó là mã của `xargs` ("một lần gọi `grep` thoát khác 0"), tức vừa có thể là
"không khớp" vừa có thể là lỗi, nên **không đủ bằng chứng**. Lần này quét từng file riêng với `grep -q`
(0 = khớp, 1 = không khớp, ≥2 = lỗi thực thi), không in giá trị:

- Phạm vi: 16 file đã sửa/mới (`git ls-files -mo --exclude-standard`).
- Mẫu: khóa riêng, AWS `AKIA…`, token GitHub `ghp_…`, khóa `sk-…`, token Slack `xox…`, và cặp
  `password/secret/api_key/token` gán chuỗi ≥8 ký tự.
- Kết quả: **không khớp = 16, khớp = 0, lỗi thực thi = 0**. Quét phần mở rộng (`.gguf .safetensors .bin
.pt .onnx .ckpt .csv .parquet .jsonl .env`): không có. File >1 MiB: không có. File sinh ra / thư mục
  phụ thuộc trong tập chưa track: không có.

### 28.2 Audit phụ thuộc (mã thoát lấy trực tiếp, không qua pipeline)

| Audit                                                           | Mã thoát | Kết luận                       |
| --------------------------------------------------------------- | -------- | ------------------------------ |
| `scripts/audit-python.ps1` (pip-audit trên `requirements.lock`) | **0**    | No known vulnerabilities found |
| `pnpm.cmd audit`                                                | **0**    | No known vulnerabilities found |

### 28.3 Thời gian chuẩn bị ngữ cảnh có nằm trong deadline có thẩm quyền không? (bằng chứng lỗi lịch sử, đã khắc phục ở mục 29)

**Không — có sai lệch so với phát biểu trước đó.** Nguồn: `LLMGateway.complete/stream` tính
`deadline = self._deadline(timeout_seconds)` rồi mở `asyncio.timeout(deadline)` **bên trong** lời gọi
gateway; `ContextService.prepare` chạy xong trước lời gọi đó. Kiểm chứng bằng chạy thực với một
estimator cố ý chậm (script tạm, đã xóa):

| Thử nghiệm                                                                         | Kết quả                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| A) chuẩn bị ≈0,30 s (2 lần `estimate` × 0,15 s), provider tức thì, deadline 0,10 s | **hoàn tất** sau 0,303 s (vượt deadline 3×) |
| B) chuẩn bị ≈0 s, provider 0,20 s, deadline 0,10 s (đối chứng)                     | `REQUEST_DEADLINE_EXCEEDED` sau 0,106 s     |

Hệ quả: chuẩn bị không _kéo dài_ deadline của gateway nhưng cũng _không được tính_ vào nó, nên thời gian
chờ tổng = chuẩn bị + deadline gateway. Chuẩn bị là đồng bộ, chặn event loop và không thể bị hủy giữa chừng.
Mức độ với cấu hình hiện tại: estimator mặc định, snapshot ≤65.536 ký tự → tối đa đo được ≈ 6,5 ms (mục
20); `ContextService` chưa được NestJS/Next.js gọi nên deadline đầu-cuối 300 s của chuỗi hiện có không bị
ảnh hưởng. Với estimator tùy biến chậm, sai lệch không bị chặn. Cách khắc phục đề xuất (chưa thực hiện vì
nằm ngoài phạm vi lần xác minh này): lấy mốc thời gian đầu `prepare`, trừ thời gian đã dùng khỏi
`timeout_seconds` (hoặc timeout của gateway nếu không truyền) trước khi gọi gateway, và trả
`REQUEST_DEADLINE_EXCEEDED` nếu còn ≤0; cần một thuộc tính chỉ đọc cho timeout của gateway và test hồi quy.

### 28.4 Hotfix CI Windows (Prettier báo 79 file)

- **Nguyên nhân gốc (đã tái hiện trước khi sửa):** repo không có `.gitattributes`; index lưu LF
  (`git ls-files --eol`: 141 file `i/lf`), `.editorconfig` và Prettier yêu cầu LF, nhưng Git for Windows
  (`core.autocrlf=true` ở cấp hệ thống, mặc định trên runner) checkout ra CRLF. Bản clone tạm với
  `core.autocrlf=true` cho 141 file `w/crlf` và Prettier báo đúng **79 file** lỗi (khớp CI).
- **Khắc phục:** thêm `.gitattributes` với một quy tắc `* text=auto eol=lf`. Không đổi Prettier,
  `.editorconfig`, workflow CI hay cấu hình Git toàn cục; không format lại hàng loạt.
- **Kiểm chứng:** trong bản clone (`core.autocrlf=true`) sau khi thêm file: 142 file `w/lf`, Prettier
  exit 0; `git status` sạch (không cần chuẩn hóa lại nội dung). Trong repo thật: `pnpm.cmd check:js` exit 0,
  `pnpm.cmd check` exit 0, `git diff --check` exit 0.
- **Chưa xác minh:** GitHub Actions chưa chạy lại với `.gitattributes` (chưa commit/push) → CI từ xa
  **vẫn NOT VERIFIED** cho đến khi workflow chạy lại thành công.

### 28.5 Diff cuối: 16 file, đều trong phạm vi

| Loại      | File                                                                                                                            | Bản chất                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cấu hình  | `.gitattributes` (mới)                                                                                                          | chuẩn hóa EOL, không chức năng                                                                                   |
| Chức năng | `domain/context.py`, `application/context.py` (mới)                                                                             | hệ thống context                                                                                                 |
| Chức năng | `application/prompts.py` (sửa)                                                                                                  | chỉ tách `resolve()`/`ResolvedPrompt` và 2 thuộc tính đọc; hành vi `PromptService` giữ nguyên (192 test cũ pass) |
| Chức năng | `domain/errors.py`, `infrastructure/logging.py`, `main.py` (sửa)                                                                | +5 lỗi; +8 khóa allowlist; lắp `ContextService`                                                                  |
| Test      | `tests/test_context_management.py` (mới)                                                                                        | 88 test                                                                                                          |
| Tài liệu  | ADR 0008, 3 tài liệu kiến trúc, `checkpoint-2.7.md` (mới); `README.md`, `system-overview.md`, `logging-privacy-policy.md` (sửa) | chỉ văn bản                                                                                                      |

Tổng: 7 file sửa (+111/−11) và 9 file mới. Không có file nhạy cảm, artifact sinh ra, trọng số model, thay đổi
manifest/lockfile hay chỉnh sửa Next.js/NestJS. `AGENTS.md` không đổi, không có `CLAUDE.md`.

### 28.6 Trạng thái chấp nhận

Các tiêu chí LOCAL PASS không đổi và vẫn được thỏa; **một giới hạn mới được ghi nhận** (28.3: thời gian
chuẩn bị nằm ngoài deadline gateway; không phải lỗi mức critical/high với cấu hình hiện tại, nhưng cần sửa
trước khi nối `ContextService` vào đường yêu cầu có deadline đầu-cuối). Nghiệm thu cục bộ, không phải phê
duyệt production; Linux và CI từ xa **NOT RUN/NOT VERIFIED**.

## 29. Khắc phục lỗi deadline [Chạy]

### 29.1 Nguyên nhân gốc

`ContextService.complete/stream` (và `PromptService.complete/stream` của 2.6, **cùng lỗi, đã xác nhận**) gọi
chuẩn bị đồng bộ rồi mới gọi gateway. Gateway chỉ bắt đầu tính deadline bên trong lời gọi của nó, nên thời
gian chuẩn bị nằm ngoài ngân sách; `PromptService` còn không có tham số timeout nào.

### 29.2 Triển khai (nhỏ nhất, không thêm dependency/thread/executor)

- `application/deadline.py` (mới): `RequestDeadline` — mốc hết hạn tuyệt đối trên đồng hồ đơn điệu
  (`time.monotonic`, có thể tiêm); `remaining()` ném `REQUEST_DEADLINE_EXCEEDED` khi còn ≤ 0.
- `application/gateway.py`: thêm `LLMGateway.deadline_seconds(timeout)` — bọc `_deadline` hiện có (kiểm tra giá
  trị sai, chặn trên bởi timeout tối đa của gateway, mặc định khi không truyền). Không đổi hành vi gateway.
- `application/context.py`: `complete/stream` lấy tổng ngân sách từ gateway, bắt đầu `RequestDeadline` **trước**
  khi chuẩn bị, rồi chỉ truyền phần còn lại cho gateway; ngân sách cạn bị từ chối ngay sau chuẩn bị và trước
  mọi lời gọi provider; timeout sai bị từ chối trước khi chuẩn bị.
- `application/prompts.py`: `PromptService.complete/stream` nhận `timeout_seconds` tùy chọn (tương thích ngược),
  cùng quy tắc; thêm tham số tiêm `clock` và thuộc tính `clock` (ContextService dùng chung đồng hồ này).
- Đường chuyển tiếp: admission, hàng đợi, first-content và inactivity của gateway chạy bên trong phần còn lại
  nên không có reset giữa hai pha; hủy, đồng thời và admission không đổi. API chat công khai không đổi
  (không đi qua hai service này).

**Giới hạn (phân biệt kế toán với ngắt cứng):** đây là _kế toán_ deadline, **không phải ngắt cưỡng bức**.
Chuẩn bị là CPU đồng bộ nên asyncio không hủy được; chuẩn bị chậm vẫn chạy hết rồi yêu cầu mới bị từ chối
(trước khi gọi provider). Ngắt cứng cần thread/process nên cố ý không thêm. Phần còn lại được tính ngay trước
lời gọi gateway, nên vài micro-giây giữa hai mốc đồng hồ không được tính. Với `stream`, ngân sách bắt đầu khi
bắt đầu lặp (generator lười).

### 29.3 Tái hiện trước/sau (estimator cố ý chậm, chạy thực)

| Kịch bản                                                     | Trước (mục 28.3)                    | Sau                                                           |
| ------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------- |
| A) chuẩn bị 2×0,15 s, provider tức thì, deadline 0,10 s      | **hoàn tất** sau 0,303 s            | `REQUEST_DEADLINE_EXCEEDED` sau 0,302 s, **provider_calls=0** |
| A2) chuẩn bị 2×0,04 s, provider tức thì, deadline 0,50 s     | —                                   | hoàn tất sau 0,082 s (đường bình thường)                      |
| B) chuẩn bị ~0, provider 0,20 s, deadline 0,10 s (đối chứng) | `REQUEST_DEADLINE_EXCEEDED` 0,106 s | `REQUEST_DEADLINE_EXCEEDED` sau 0,110 s (không đổi)           |
| C) chuẩn bị 2×0,04 s + provider 0,20 s, deadline 0,20 s      | (tổng được phép ≈0,28 s)            | `REQUEST_DEADLINE_EXCEEDED` sau 0,202 s (ngân sách chung)     |

Lưu ý A: chuẩn bị vẫn tốn 0,302 s (không thể ngắt) nhưng yêu cầu bị từ chối và provider không được gọi.

### 29.4 Test hồi quy [Chạy]

`tests/test_request_deadline.py` (17 test, đồng hồ giả + provider giả tất định, chạy 5 lần liên tiếp đều ổn
định): chuẩn bị dùng hết ngân sách (completion và streaming, provider và gateway không được gọi); dùng một
phần (gateway nhận đúng phần còn lại 0,6 s); timeout mặc định của gateway khi caller không truyền; timeout của
caller không vượt mức tối đa của gateway; timeout sai (0, âm, bool, chuỗi) giữ nguyên lỗi và bỏ qua chuẩn bị;
lỗi xác thực vẫn thắng kiểm tra deadline; `PromptService` cùng quy tắc và tương thích ngược; thời gian chờ
hàng đợi bị chặn bởi ngân sách riêng và yêu cầu chờ không bao giờ tới provider; quá tải, hủy và phục hồi
capacity; provider hết hạn giải phóng capacity; `RequestDeadline` dùng đồng hồ đơn điệu tiêm được; đồng hồ mặc
định là `time.monotonic`.

| Lệnh                                              | Mã thoát | Kết quả                                             |
| ------------------------------------------------- | -------- | --------------------------------------------------- |
| `pytest` (toàn bộ Python)                         | **0**    | **297 passed**, 9 live skipped (280 trước + 17 mới) |
| `ruff check .`                                    | **0**    | All checks passed                                   |
| `ruff format --check .`                           | **0**    | 52 file đã đúng định dạng                           |
| `mypy src tests` (strict)                         | **0**    | no issues, 52 file                                  |
| `pnpm.cmd check`, quét bí mật, `git diff --check` | xem 29.6 |                                                     |

Test cũ không bị sửa hay nới lỏng (280 test trước đó vẫn pass nguyên vẹn sau thay đổi).

### 29.5 Kiểm chứng live với Ollama hiện có [Chạy]

Đường thực thi có đổi (gateway nhận phần còn lại) nên đã kiểm chứng live với `qwen3.5:35b` hiện có, không
tải model, không đổi cấu hình. Tiến trình Ollama hiện là PID 2164 (khởi động 08:29 sáng nay, trước phiên này;
khác PID 3388 ở báo cáo cũ vì dịch vụ đã khởi động lại bên ngoài, không do lượt này), vẫn chỉ lắng nghe `127.0.0.1:11434` và
không bị dừng/khởi động bởi lượt này.

- Suite live hiện có: **9 passed** (191,44 s, gồm nạp model lạnh), mã thoát 0.
- Harness tạm (đã xóa; mã thoát 0): `ContextService.complete` với `timeout_seconds=290` hoàn tất, `stop`, usage
  34/13; `PromptService.complete` (`timeout_seconds=60`) hoàn tất (`length` do giới hạn 24 token); `ContextService.stream`
  8 sự kiện (6 `ContentDelta`, **1** sự kiện kết thúc); **hết hạn thật** `timeout_seconds=0,05` →
  `REQUEST_DEADLINE_EXCEEDED` sau 0,058 s; yêu cầu phục hồi hoàn tất sau 0,496 s với operations còn lại 0,
  semaphore rảnh 1, 0 task treo.

### 29.6 Quality gate cuối [Chạy]

| Lệnh / kiểm tra                                                | Mã thoát                       | Kết quả                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm.cmd check` (lệnh gộp, chạy sau khi hoàn tất thay đổi mã) | **0**                          | Prettier toàn repo, ESLint, TypeScript, build, web 7/7, NestJS unit 12/12, e2e 13/13, Ruff, mypy strict (52 file), Python **297 passed**, 9 skipped |
| `git diff --check`                                             | **0**                          | chỉ cảnh báo thông tin LF→CRLF                                                                                                                      |
| Quét bí mật trên 20 file đã sửa/mới                            | n/a (phân loại theo từng file) | không khớp 20, khớp 0, lỗi thực thi 0; không có trọng số/dataset/file >1 MiB                                                                        |
| Suite live Ollama hiện có                                      | **0**                          | 9 passed                                                                                                                                            |

Tập thay đổi cuối là **20 file** (7 file sửa ban đầu + `application/gateway.py` + `docs/architecture/llm-gateway.md`
= 9 file sửa; 11 file mới gồm `.gitattributes`, `application/deadline.py`, `tests/test_request_deadline.py`);
mọi thay đổi chức năng trong lượt này chỉ nằm ở `deadline.py`, `gateway.py` (+1 phương thức công khai),
`context.py`, `prompts.py` và test mới. Audit phụ thuộc không chạy lại: không có thay đổi dependency/lockfile
(kết quả mục 28.2 vẫn là bằng chứng hiện hành). Linux và CI từ xa vẫn **NOT RUN/NOT VERIFIED**.

### 29.7 Trạng thái sau khắc phục

**LOCAL PASS** được giữ nguyên; giới hạn deadline ở mục 24/28.3 đã được xử lý (kế toán deadline), còn lại
giới hạn đã nêu: chuẩn bị đồng bộ không thể bị ngắt cưỡng bức. Sẵn sàng cho Checkpoint 2.8 sau khi chủ dự án duyệt.
