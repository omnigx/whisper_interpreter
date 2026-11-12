# Speech Dictionary (STT term post-correction)

- `default.json` is a runtime-generated persistence file (**not tracked in git**; kept locally).
- Import external JSON files via the "Speech Dictionary → Load" button in the main UI. Three formats are accepted:
  - Error→correct pairs: `{"吸出": "析出"}`
  - Target terms only (self-mapping, for fuzzy mode): `{"固溶": "固溶"}` or `["固溶", "析出"]`
  - Mixed formats are merged naturally; single-character entries are filtered out (to prevent over-correction).
- Import and parsing rules live in `src/renderer/src/utils/speechDict.ts` (`normalizeDictJson`).

---

# 语音字典（STT 术语后纠）

- `default.json` 为运行时自动生成的持久化文件（**不入库**，本地保留）
- 通过主界面"语音字典 → 加载"按钮导入外部 JSON，支持：
  - 原词对：`{"吸出": "析出"}`
  - 仅目标词（自映射，模糊模式用）：`{"固溶": "固溶"}` 或 `["固溶", "析出"]`
  - 混合格式自然兼容；单字条目会被过滤（防过度纠正）
- 导入与解析规则见 `src/renderer/src/utils/speechDict.ts`（`normalizeDictJson`）
