# 语音到后端 Agent 的交接：官方资料与可落地机制

调研于 2026-11-22。依据为 OpenAI、LiveKit、Pipecat、Deepgram、AssemblyAI、Google、AWS 的官方文档，OpenAI 官方示例仓库的 README，以及 Jurafsky & Martin 教材和相关论文原文。每条事实后面的链接指向拥有该事实的页面。OpenAI 的 GPT-Live（`/v1/live/sessions`）文档已找到并直接引用；凡是来自 Realtime API 的内容都单独标注为「Realtime」，不当作 Live 的事实。未能打开或未能确认的内容集中列在第四节。

Athena 现状取自 [live-voice.ts](../src/main/live-voice.ts)、[live-voice-client.ts](../src/renderer/live-voice-client.ts)、[shared/live-voice.ts](../src/shared/live-voice.ts) 和 [main.ts](../src/main/main.ts) 中的 `runTask`。

## 一、结论先行

- GPT-Live 的 client delegation 事件只带时间戳和 ID，不带用户原话和任务文本；用户想要什么，由应用自己从转写和应用状态推断。官方同时写明转写片段不是完整的一轮，且可能有错。[Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation#keep-the-conversation-context-in-your-application)
- Live 没有标记「用户一轮说完」的事件，转写片段也没有 item ID；怎样分组由应用决定。Live 会话配置里没有找到 VAD 或 turn detection 字段，这一点与 Realtime 不同。[Transcript deltas](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)、[Live API reference](https://developers.openai.com/api/reference/resources/live/primary-websocket)
- 官方在 Live 的三份指南里反复写同一句话：权限和必需的确认由应用代码执行，不交给语音模型或后端模型的提示词。[Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting)、[Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
- `session.commentary.append` 的内容会被模型转述，`session.thinking.append` 的内容可影响之后的话；大段上下文会增加幻觉，模型可能在用完整段更新之前就开口。要保证措辞或保证没说多余的话，只能由应用控制播放。[Context and exact wording](https://developers.openai.com/api/docs/guides/live-prompting#context-and-exact-wording)、[Understand when context reaches the model](https://developers.openai.com/api/docs/guides/live-conversations#understand-when-context-reaches-the-model)
- 「先问能力或确认对象，再提要求」是对话里的常规结构（presequence），「问」和「要求」是不同的言语行为；显式确认易于纠错但费时，隐式确认是把理解顺带说回去；教材给出按 ASR 置信度分四档的做法。[SLP3 第 26 章](https://web.stanford.edu/~jurafsky/slp3/26.pdf)、[SLP3 附录 K](https://web.stanford.edu/~jurafsky/slp3/K.pdf)
- 按风险分级确认有官方依据（Realtime）：只读、低风险的工具可以直接调用，会修改数据的工具先复述再等用户确认，不可逆动作显式确认。[Prompting Realtime models](https://developers.openai.com/api/docs/guides/realtime-models-prompting)
- 各家的轮次结束判定都是「静音时长 + 语义或声学模型 + 超时兜底」的组合，文档都承认这是启发式，会在提前打断和反应迟钝之间取舍。[AssemblyAI](https://www.assemblyai.com/docs/speech-to-text/universal-streaming/turn-detection)、[Deepgram](https://developers.deepgram.com/docs/understanding-end-of-speech-detection)
- Live 的转写事件示例里只有 `delta`、`start_ms`、`end_ms`，没有看到置信度字段；因此教材里按置信度分档的做法在 Live 上没有现成输入，需要换成别的可核对信号。[Transcript deltas](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)

## 二、各主题的来源事实

### 1. OpenAI：Live 与 Realtime

**Live（`gpt-live-1`、`gpt-live-1.1`）**

- `gpt-live-1` 是全双工语音模型，可以边听边说，把推理和工具使用委托给后端 Agent。[GPT-Live-1 模型页](https://developers.openai.com/api/docs/models/gpt-live-1)
- `gpt-live-1.1` 已发布，模型页写明它比 `gpt-live-1` 转写更准，并且用自然语言描述何时交给后端。[GPT-Live-1.1 模型页](https://developers.openai.com/api/docs/models/gpt-live-1.1)
- 提示词模板按 `gpt-live-1.1` 写；对 `gpt-live-1`，官方要求把模板里的 “Delegate to the backend” 换成 `Generate <|SpawnThinking|>`，“Do not delegate” 换成 `Do not generate <|SpawnThinking|>`。[Recommended prompt structure](https://developers.openai.com/api/docs/guides/live-prompting#recommended-prompt-structure)
- 模板的「不委托」条件包括：需要一句简短澄清才能听懂请求时。「委托」条件包括：一次更正改变了已请求的工作。[Recommended prompt structure](https://developers.openai.com/api/docs/guides/live-prompting#recommended-prompt-structure)
- “A spoken promise such as ‘I’m checking that’ does not confirm that backend work has started.” 语音模型要等后端结果再说价格、预订成功或动作完成。[Delegation](https://developers.openai.com/api/docs/guides/live-prompting#delegation)
- client delegation 下，`session.delegation.created` 含 `offset_ms`、`delegation.id`、`delegation.target`，不含用户话语和任务文本；应用要保存足够的历史来理解 “yes” 这类短回答和 “Thursday, not Friday” 这类更正。[Keep the conversation context in your application](https://developers.openai.com/api/docs/guides/live-delegation#keep-the-conversation-context-in-your-application)
- 转写的 `start_ms`、`end_ms` 是会话时间线上的近似区间；官方要求用它们而不是数据包到达时间来组织转写，并提醒送达不均匀，送达间隙可能只是网络延迟。[Transcript deltas](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)
- 应用可以在 delegation 事件到来之前就处理转写片段：提前开始查询、跑 guardrail、更新界面。片段可能不完整，后面的话可能改变请求；要丢弃过期结果，并在有后果的动作之前照常做权限和确认检查。[React to transcript fragments](https://developers.openai.com/api/docs/guides/live-delegation#react-to-transcript-fragments)
- 官方 Cookbook 的例子里，Decisions trigger 挂在用户转写上，在 GPT-Live 的交接来晚时标记「回答已说完」，应用记录实际是哪一个信号启动了工作，并且只启动一次。[Build a voice agent that follows an SOP](https://developers.openai.com/cookbook/articles/sop_to_voice_agent_builder#manage-workflows-during-a-live-call)、[React to transcripts](https://developers.openai.com/api/docs/guides/decisions-voice#react-to-transcripts)
- 三种追加事件的用途：`session.instructions.append` 是应用给出的指令，`session.thinking.append` 是不立即说出的事实，`session.commentary.append` 是让模型说出来的信息，模型会转述。每次最多 500 token。[Send the right kind of update](https://developers.openai.com/api/docs/guides/live-delegation#send-the-right-kind-of-update)
- 通过 `session.thinking.append` 送进去的内容也会影响之后说的话；助手可能复述任何一种事件里的信息。[Add context during the conversation](https://developers.openai.com/api/docs/guides/live-conversations#add-context-during-the-conversation)
- “Large context updates can increase hallucinations”，JSON、表格之类的结构化数据要先概括再送。[Context and exact wording](https://developers.openai.com/api/docs/guides/live-prompting#context-and-exact-wording)
- 追加事件的确认只表示上下文按估计已送达，不表示已说完或已播放；模型可能在用完整段更新之前就回应。[Understand when context reaches the model](https://developers.openai.com/api/docs/guides/live-conversations#understand-when-context-reaches-the-model)
- 后端提示词模板要求返回「相关事实、任务当前状态、下一步」，工具或服务确认成功后才报告完成，结果不清楚就照实说。[Start with your existing backend prompt](https://developers.openai.com/api/docs/guides/live-delegation#start-with-your-existing-backend-prompt)
- 应用可以用 `session.output_transcript.delta` 检查助手的话里有没有 “unsupported claims”，触发后用 `session.instructions.append` 纠正；纠正指令收不回用户已经听到的音频。[Apply conversation guardrails](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live#apply-conversation-guardrails)
- 要在播放前检查助手的话，应用得自己缓冲音频、等对应转写、通过后再放；Live 不提供输出侧 VAD，缓冲会增加延迟，被丢弃的话仍留在模型的上下文里。[Check speech before playback](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live#check-speech-before-playback)
- 打断只停止说话，后端工作继续运行；用户改了任务，应用要同步更新进行中的工作。指令能让模型倾向于让出话轮，但不能精确控制它何时停。[Interruptions](https://developers.openai.com/api/docs/guides/live-prompting#interruptions)
- 用户改口时，应用更新当前任务，忽略过期请求的结果；重试失败的工具调用之前，先查原动作是否已经发生。[Keep updates accurate and useful](https://developers.openai.com/api/docs/guides/live-delegation#keep-updates-accurate-and-useful)
- 官方建议每个应用动作有自己的 operation ID，每次改口有 task revision，与 delegation ID 并列记录。[Verify the complete interaction](https://developers.openai.com/api/docs/guides/live-delegation#verify-the-complete-interaction)
- 迁移指南举例：“yes” 可能是确认一个时段、回应一个问题，或指向更早的建议；用户改口后要清掉旧选项上的确认，执行前再核对日期、时段和确认是否仍对应当前请求。[Migrate to GPT-Live](https://developers.openai.com/api/docs/guides/live-migration)
- `delegation.acknowledgement_delay_ms` 取 0–800，普通会话默认 0；它只推迟自动口头应答的请求，模型仍可能更早开口。[Live API reference](https://developers.openai.com/api/reference/resources/live/primary-websocket)、[Suppress automatic acknowledgments](https://developers.openai.com/api/docs/guides/live-delegation#suppress-automatic-acknowledgments-while-tools-run)
- 页面和界面状态用 `session.thinking.append`（`delegation_id: null`）给出简短摘要，帮助模型理解 “this option” 这类指代；完整 HTML 和 DOM 留在应用里，页面内容当作数据而不是指令。[Share UI context](https://developers.openai.com/api/docs/guides/live-delegation#share-ui-context)
- 重要的名字、日期、数字听不清时，只问不清楚的那一部分，不猜缺失的值。[Unclear names, dates, and numbers](https://developers.openai.com/api/docs/guides/live-prompting#unclear-names-dates-and-numbers)

**Realtime（不是 Live）**

- Realtime 有两种 VAD：`server_vad` 按静音切分，参数为 `threshold`、`prefix_padding_ms`、`silence_duration_ms`（文档示例为 0.5、300、500）；`semantic_vad` 用语义分类器估计用户是否说完，概率低时等更久，`eagerness` 取 `low`、`medium`、`high`、`auto`，`auto` 等同 `medium`。[Voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad)
- Realtime 的输入转写由另一个 ASR 模型产生，“may diverge somewhat from the model's interpretation, and should be treated as a rough guide”。[Realtime server events](https://developers.openai.com/api/reference/resources/realtime/server-events#conversation.item.input_audio_transcription.completed)
- Realtime 会话可通过 `include` 取 `item.input_audio_transcription.logprobs`。[Realtime sessions reference](https://developers.openai.com/api/reference/resources/realtime/subresources/sessions/methods/create)
- Realtime 在用户打断时取消当前回应，并截掉未播放的部分（WebRTC、SIP 由服务端完成，WebSocket 由客户端发 `conversation.item.truncate`）。[Interruption and Truncation](https://developers.openai.com/api/docs/guides/realtime-conversations#interruption-and-truncation)
- Realtime 提示指南：只读、低风险的动作适合高 eagerness；会修改数据、触发外部影响或依赖精确标识的工具适合低 eagerness。写操作 “Summarize the intended action before calling the tool”，并且 “Do not call the tool until the user clearly confirms”；不可逆动作显式确认。[Prompting Realtime models](https://developers.openai.com/api/docs/guides/realtime-models-prompting)
- 同一指南反对一刀切：推荐写「会修改用户数据的写操作先确认」，不推荐写「做任何事之前都确认」。[Prompting Realtime models](https://developers.openai.com/api/docs/guides/realtime-models-prompting)
- 同一指南：“Do not guess what the user meant from unclear audio”，同一个听不清的澄清不要重复两次，不要用猜测的、不完整的或未确认的值调用工具。[Prompting Realtime models](https://developers.openai.com/api/docs/guides/realtime-models-prompting)

### 2. 轮次结束判定

| 来源 | 结束信号 | 可调参数与文档默认值 | 文档写明的取舍 |
| --- | --- | --- | --- |
| OpenAI Realtime `server_vad` | 静音时长 | `silence_duration_ms`，示例 500 | 值越短越快判定结束 |
| OpenAI Realtime `semantic_vad` | 语义分类器 + 超时 | `eagerness`，默认 `auto`（同 `medium`） | `low` 让用户慢慢说，`high` 尽快切分 |
| LiveKit turn detector | VAD 之上叠加模型预测；多模态版本读 Agent 上一句并听用户的语调、音高、节奏 | `min_delay` 0.5 s（多模态 0.3 s），`max_delay` 3.0 s（多模态 2.5 s），`unlikely_threshold` 按语言校准 | 阈值低更急，高更有耐心；约一秒没有预测就直接提交 |
| Pipecat | VAD 提供语音/静音，turn strategy 做最终决定；默认停止策略是 Smart Turn 模型分析音频 | Silero `start_secs` 0.2、`stop_secs` 0.2 | “A pause doesn't mean the user is done.” |
| Deepgram endpointing | 静音 | `endpointing` 默认 10 ms | 背景噪声会让 `speech_final` 发不出来 |
| Deepgram UtteranceEnd | 最后一个定稿词之后的词间隙 | `utterance_end_ms` 1000–5000，需 `interim_results=true` | 低于 1000 ms 没有收益 |
| Deepgram Flux | 轮次结束置信度 + 超时 | `eot_threshold` 0.5–1.0 默认 0.7；`eot_timeout_ms` 500–60000 默认 5000；`eager_eot_threshold` 默认不设 | 阈值高则误判少、略慢；eager 模式降低延迟但增加 LLM 调用，并要处理 `TurnResumed` 取消 |
| AssemblyAI | 停顿时按已说内容判断是否说完；以实体结尾可能还没说完时保持开放 | `balanced`：`min_turn_silence` 128 ms、`max_turn_silence` 1280 ms；`max_accuracy`：512、2560 | 过早结束会打断说话人，过晚则显得迟钝 |
| Gemini Live API | 服务端自动 VAD | `silenceDurationMs` 内部默认约 800 ms，建议 500–800 ms；可关闭后由客户端发 `activityStart`、`activityEnd` | 100–200 ms 过低，2000 ms 以上过高 |
| Amazon Nova 2 Sonic | 文档只写有 “Intelligent turn-taking” | 本次未找到参数 | 未找到 |

来源依次为：[OpenAI VAD](https://developers.openai.com/api/docs/guides/realtime-vad)、[LiveKit turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector.md)、[Pipecat Speech Input & Turn Detection](https://docs.pipecat.ai/pipecat/learn/speech-input.md)、[Deepgram Endpointing](https://developers.deepgram.com/docs/endpointing)、[Deepgram Utterance End](https://developers.deepgram.com/docs/utterance-end)、[Deepgram Flux 参数](https://developers.deepgram.com/docs/flux/configuration)、[AssemblyAI Turn Detection](https://www.assemblyai.com/docs/speech-to-text/universal-streaming/turn-detection)、[Gemini Live API capabilities](https://aistudio.google.com/docs/live-api/capabilities)、[Amazon Nova 2 Sonic](https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-conversational-speech.html)。

补充事实：

- LiveKit 的模式清单是 turn detector 模型、realtime 模型自带检测、仅 VAD、STT 端点检测、手动控制；多模态检测器的语言列表含中文。[Turns overview](https://docs.livekit.io/agents/logic/turns.md)、[LiveKit turn detector](https://docs.livekit.io/agents/logic/turns/turn-detector.md)
- Pipecat 的停止策略默认要全部同意才结束一轮；用户先开口，之前的决定就清空。可以在 Smart Turn 之后再加「话是否完整」的检查，由对话 LLM 或分类器给出。[Pipecat Speech Input & Turn Detection](https://docs.pipecat.ai/pipecat/learn/speech-input.md)
- Deepgram 建议两个信号一起用：收到 `speech_final=true` 就触发；收到 `UtteranceEnd` 而之前没有 `speech_final=true` 也触发。同页写明任何判断说完与否的方法都是启发式，少数情况下会失败。[End of speech detection](https://developers.deepgram.com/docs/understanding-end-of-speech-detection)
- AssemblyAI 给出实体感知端点检测的数据：电话号码实体错误率由 7.0% 降到 2.2%，中位延迟不变，90 分位延迟由 0.83 s 升到 1.64 s，代价落在约十分之一被保持的轮次上。[AssemblyAI Turn Detection](https://www.assemblyai.com/docs/speech-to-text/universal-streaming/turn-detection)
- Gemini 检测到打断时取消并丢弃正在生成的内容，待处理的函数调用也被丢弃，服务端发回被取消调用的 ID。[Gemini Live API capabilities](https://aistudio.google.com/docs/live-api/capabilities)
- 教材对这个任务的定性：端点检测 “can be quite challenging because of noise and because people often pause in the middle of turns”。[SLP3 第 26 章 26.1.1](https://web.stanford.edu/~jurafsky/slp3/26.pdf)

### 3. 工具调用的安全模式

**一方工程文档**

- OpenAI Agents SDK（JS）：`needsApproval` 可以是 `true`，也可以是返回布尔值的异步函数，函数拿到解析后的参数；需要批准而没有决定时，工具调用不执行，运行暂停并在 `interruptions` 里返回待批项。参数 JSON 损坏或不是对象时按「需要批准」处理（fail closed）。[Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- 同一 SDK 的 Realtime 会话：`needsApproval: true` 的工具在执行前发出 `tool_approval_requested`，由 `session.approve` 或 `session.reject` 决定；等待批准期间 Agent 不能处理用户的新请求。[Building Voice Agents](https://openai.github.io/openai-agents-js/guides/voice-agents/build/)
- 同一 SDK 的输出 guardrail 跑在助手回应的转写上，异步执行，默认每 100 个字符检查一次，触发时发出 `guardrail_tripped`。[Building Voice Agents](https://openai.github.io/openai-agents-js/guides/voice-agents/build/)
- LiveKit：工具默认可被用户说话打断，但打断不取消工作；会产生无法回滚的外部动作的工具，应在开头调用 `run_ctx.disallow_interruptions()`，否则操作可能停在半途而无法回滚。[LiveKit Function tools](https://docs.livekit.io/agents/logic/tools/definition.md)
- Live Cookbook 的做法：后端模型只「提出」一个工具，应用核对订单和来电者的同意之后才创建换货；结束前由语音模型读回两个选择并请用户确认，应用核对当前摘要和它被说出的证据后才完成。[SOP Cookbook：Manage workflows during a live call](https://developers.openai.com/cookbook/articles/sop_to_voice_agent_builder#manage-workflows-during-a-live-call)、[When one reply answers two questions](https://developers.openai.com/cookbook/articles/sop_to_voice_agent_builder#when-one-reply-answers-two-questions)
- Live 的 guardrail 流程：检查返回一个小的结构化结果（文档举例 `{"triggered": true}`），应用在状态里把请求标为 blocked，执行工具或提交改动前先查这个状态，检查失败或超时就保持阻断。[Run checks alongside the conversation](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live#run-checks-alongside-the-conversation)

**口语对话系统文献**

- Grounding：对话双方要建立共同认可的内容（common ground）；听者要表明自己是否听懂。Clark & Schaefer（1989）把每次贡献分成 presentation 和 acceptance 两个阶段，并按强弱列出五种 grounding 方式，从继续注意到逐字复述（display）。[SLP3 第 26 章 26.1.3](https://web.stanford.edu/~jurafsky/slp3/26.pdf)；原文 [Clark & Schaefer 1989, Cognitive Science 13(2)](https://onlinelibrary.wiley.com/doi/10.1207/s15516709cog1302_7)
- 教材指出非语言动作同样需要 grounding：电梯按钮按下后亮起，就是对「已呼叫」的确认。[SLP3 第 26 章 26.1.3](https://web.stanford.edu/~jurafsky/slp3/26.pdf)
- Presequence：用户常先问系统能力再提要求，教材的例子是 “Can you make train reservations?”，系统答 “Yes I can.”，用户随后才提出预订。[SLP3 第 26 章 26.1.4](https://web.stanford.edu/~jurafsky/slp3/26.pdf)
- 澄清问句是 REQUEST 与 RESPONSE 之间的旁支序列，在语音识别出错的对话系统里尤其常见；教材的例子是只问没听清的那一部分（“going where on the 5th?”）。[SLP3 第 26 章 26.1.4](https://web.stanford.edu/~jurafsky/slp3/26.pdf)
- 显式确认是直接问 “Is that correct?”；隐式确认是把系统的理解放进下一句话里顺带说出。取舍：显式确认让用户答一声 “no” 就能纠正，但 “time-consuming and awkward”。[SLP3 附录 K.1.3](https://web.stanford.edu/~jurafsky/slp3/K.pdf)
- 按 ASR 置信度选择动作：低于 α 拒识，高于 α 显式确认，高于 β 隐式确认，高于 γ 不确认。[SLP3 附录 K.1.3](https://web.stanford.edu/~jurafsky/slp3/K.pdf)
- 对话状态不只是当前这句话里的槽位，而是到此刻为止整个 frame 的状态；对话行为（inform、request、confirm 等）与槽位填充常常联合判定。[SLP3 附录 K.1](https://web.stanford.edu/~jurafsky/slp3/K.pdf)
- 用户更正比普通句子更难识别，常伴随 hyperarticulation；检测更正要用到与上一句的语义和语音相似度、韵律和 ASR 置信度。[SLP3 附录 K.1.2](https://web.stanford.edu/~jurafsky/slp3/K.pdf)
- Dialog State Tracking Challenge：ASR 和 SLU 错误常见，会让系统误解用户需要；多数商用系统只取置信度最高的 SLU 结果、丢掉其他候选，统计方法则为多个状态假设打分。[Williams et al. 2013, SIGDIAL](https://aclanthology.org/W13-4065.pdf)
- Slot carryover：把上下文理解表述为「对每个候选槽位，决定是否沿用到当前轮」的判定问题。[Naik et al. 2018, Interspeech](https://arxiv.org/abs/1806.01773)

### 4. 结构化的意图交接

- OpenAI 官方示例仓库的 Chat-Supervisor 模式：realtime 聊天 Agent 负责问候、闲聊和收集信息，文本 supervisor 模型负责工具调用和较难的回应；README 只写聊天 Agent “Forwards message/context”，没有规定交接内容的结构。代价是延迟略增，更多回应以 “Let me think” 开头。[openai-realtime-agents README](https://github.com/openai/openai-realtime-agents/blob/main/README.md)
- OpenAI Agents SDK（JS）的 “Delegation through tools”：语音 Agent 通过一个工具把请求连同会话历史交给后端 Agent，后端 Agent 用 `outputType`（zod 对象）返回结构化结果。文档同时提醒：用户最后一句话的转写在工具执行时可能还没到。[Building Voice Agents](https://openai.github.io/openai-agents-js/guides/voice-agents/build/)
- Live 的 client delegation 没有任何由语音模型填写的结构：通知本身不含请求文本和工具参数，后端请求由应用用转写和状态组装。[Migrate to GPT-Live](https://developers.openai.com/api/docs/guides/live-migration)、[Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation#keep-the-conversation-context-in-your-application)
- Live 官方建议后端把更新标成 progress 或 result，让应用据此选择追加事件；如果用文本前缀标记，要等前缀完整再转发。[Client delegation](https://developers.openai.com/api/docs/guides/live-delegation#reduce-backend-latency)
- Pipecat 的 `LLMWithBackend`（alpha）：前端 LLM 用 `delegate` 工具交接并继续说话；默认策略 `TranscriptBackendRequestStrategy` 的 `delegate` 不带参数，后端读转写；speech-to-speech 前端则由模型自己措辞。后端的结果由前端「用自己的话」转述，进度、函数调用和推理静默到达前端。更正和「算了」同样被委托，后端取消不再需要结果的工具调用。[Pipecat LLM with a Backend](https://docs.pipecat.ai/pipecat/learn/llm-with-backend.md)
- LiveKit 的工具可以在后台运行，让 Agent 在长任务期间继续说话。[LiveKit Tool definition and use](https://docs.livekit.io/agents/logic/tools.md)

本次没有找到一方来源对「结构化交接比自由文本更少出错」给出量化对比，见第四节。

### 5. ASR 错误处理

- Live 的转写可能有错，片段不是完整的一轮；Live 指南给出的转写事件只有文本和时间区间。[Keep the conversation context in your application](https://developers.openai.com/api/docs/guides/live-delegation#keep-the-conversation-context-in-your-application)、[Transcript deltas](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas)
- 后端提示词模板的原话：转写 “can contain mistakes, unfinished phrases, and later corrections”，需要的细节仍不清楚时，问那个细节而不是猜。[Start with your existing backend prompt](https://developers.openai.com/api/docs/guides/live-delegation#start-with-your-existing-backend-prompt)
- 用户键入的值直接作为用户数据送给后端，让后端用到准确文本。[Accept typed input](https://developers.openai.com/api/docs/guides/live-delegation#accept-typed-input)
- Realtime（不是 Live）：转录模型 `gpt-live-transcribe` 不返回词级时间戳、说话人标签和置信度分数；文档建议为不支持的置信度字段保留回退路径。[Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- Google Cloud Speech-to-Text：`confidence` 是 0.0 到 1.0 的数，可按词返回（`enableWordConfidence`）；该页没有给出如何据此决定是否确认的指导。[Word-level confidence](https://docs.cloud.google.com/speech-to-text/docs/word-confidence)
- Gemini Live API 的输入转写支持 `custom_vocabulary`，最多 1,000 个词，文档称 100 个以内效果最好。[Gemini Live API capabilities](https://aistudio.google.com/docs/live-api/capabilities)
- 置信度分档（拒识、显式确认、隐式确认、不确认）与「取最高分、丢掉候选」的局限，见上一小节的 [SLP3 附录 K.1.3](https://web.stanford.edu/~jurafsky/slp3/K.pdf) 和 [Williams et al. 2013](https://aclanthology.org/W13-4065.pdf)。
- Live 评测指南建议按需加入对字母数字串、名字和数字的识别、转写准确率（WER）和读回表现的专项检查。[GPT-Live evaluation guide](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation#metrics)

## 三、对 Athena 的建议

以下是根据上述事实做出的设计判断，不是来源的原话。先说现状里与官方文档对不上的三处，它们直接关系到已观察到的失败：

- 结果回传：[live-voice-client.ts](../src/renderer/live-voice-client.ts) 把后端全文按 400 字节切块用 `session.thinking.append` 送入（最多 8000 字），再用 `session.commentary.append` 送一句「请简短说明上述后端结果…」。按官方定义，commentary 是让模型说出来并转述的内容，指令应走 `session.instructions.append`；大段上下文会增加幻觉，模型可能在用完整段更新之前就开口。语音模型编出「因为你指着它」，与这条路径相符。
- 模型与提示词：[live-voice.ts](../src/main/live-voice.ts) 用的是 `gpt-live-1`，指令用自然语言写「委托给后端」。官方要求 `gpt-live-1` 用 `<|SpawnThinking|>` 的写法，自然语言描述是 `gpt-live-1.1` 的用法，且后者转写更准。
- 交接等待：客户端按片段的到达时间判断用户是否说完（0.9 s 无新片段，最长 4 s）。官方要求按 `start_ms`、`end_ms` 而不是到达时间组织转写，并提醒到达间隙可能只是网络延迟。

机制按预期收益排序。

### 1. 修改前必须申报结构化请求，宿主按申报放行（确定性机制）

- 做法：语音回合里，后端 Agent 在任何会修改页面的工具之前，必须先调用一个申报工具（暂称 `workbench_voice_request`），内容为：`act`（`ask`、`locate`、`change`、`undo`、`clarify`）、`target`（ref 或 selector，加一句描述）、`changes`（属性与值的列表）、每个值的 `evidence`（取自「本次新增」用户原话的逐字片段）、`missing`（缺的槽位）、`confidence`。宿主在这一回合里记住申报，并对修改类工具（`workbench_browser_edit`、`workbench_browser_restyle`、`workbench_browser_create_page`、`workbench_browser_fill` 等）做三项检查：
  - `act` 为 `ask`、`locate`、`clarify`，或没有申报：拒绝修改类工具，只放行 `workbench_browser_inspect`、`workbench_browser_query` 等只读工具。
  - 工具调用的目标与申报的 `target` 不一致，或改动了申报之外的属性：拒绝。
  - 每个 `evidence` 必须是本次新增用户转写的子串（由宿主用字符串比对核实，转写由宿主自己持有，不采信模型转述）；值在本次原话里找不到，说明它来自之前的回合，拒绝并让 Agent 改为提问。
- 对应失败：「看到了吗」会被申报为 `ask`，或者被错报为 `change` 但拿不出「橙色」的原话证据，两条路都改不了页面。这是把「不沿用属性」从提示词搬到代码里。
- 依据：权限和确认由应用代码执行；guardrail 用小的结构化结果、执行前查状态、失败即阻断（Live 文档）。`needsApproval` 可按参数判定、参数损坏即 fail closed（Agents SDK）。问与要求是不同的对话行为，presequence 是常规结构；沿用槽位应是逐个判定而不是默认（SLP3、Naik et al.）。
- 代价：每个语音回合多一次工具调用，延迟未测量；`ask` 和 `locate` 不经过修改路径，不受影响。
- 残余失败：转写把「橙色」写成同音词时，证据比对会误拒，表现为多问一句而不是改错；用户确实想沿用（「这个也一样」）时需要在申报里显式标出来源回合，并归入下一条的确认；模型把目标选错但申报与调用一致时，这道闸拦不住，要靠第 2 条的读回和撤销。工具的只读、修改分类是按名字做的初步划分，落地前要对照工具实现逐个确认。

### 2. 回传给语音模型的内容由代码生成，不把全文和指令混着送（确定性机制为主，说出口的部分仍是提示级）

- 做法：后端 Agent 的收尾输出改为固定字段（做了什么、对象、改动、没做什么、要问用户的一个问题、状态：完成、未做、失败、待确认），宿主用模板拼成一两句话，单条 `session.commentary.append` 送出，不带「原因」字段，长度远低于 500 token。全文只留在 Athena 对话里，不再切块送 `session.thinking.append`。行为规则放进会话 `instructions`，不放进 commentary。同时在界面上把这句核实过的结果以文字显示，作为不经过语音模型的那一份。
- 检测：订阅 `session.output_transcript.delta`，在一次委托的结果送出后的若干秒内，把助手说的话与模板字段比对（出现模板里没有的颜色、对象名，或「因为」「由于」之类的原因从句即记为越界），触发时用 `session.instructions.append` 纠正并计入指标。
- 依据：commentary 会被转述，thinking 也会影响之后的话，大段上下文增加幻觉，模型可能在更新送完前回应，纠正指令收不回已播出的音频（Live 文档）。Agents SDK 的输出 guardrail 同样跑在输出转写上。
- 代价：需要后端 Agent 按字段收尾；检测是事后的，不增加延迟。
- 残余失败：转述仍由模型完成，偶发多说无法杜绝；要做到「没核实的话不出声」，只有官方给出的缓冲播放一条路，它增加延迟且被丢弃的话仍在模型上下文里，不建议现在做。

### 3. 按风险分级确认，配合撤销台账（分级与台账是确定性机制，听懂用户的「对」是提示级）

- 分级：
  - 只读（`inspect`、`query`、截图）：不确认。
  - 可撤销的页面预览改动：隐式确认。先改，随后用第 2 条的模板读回「对象 + 改动」，并保留撤销窗口；用户说「不对」「不是这个」时，下一回合的申报为 `undo`，宿主按台账撤销。
  - 不可撤销或越出页面的动作（写入真实源码、提交、推送、导航离开未保存的页面、沙箱外的操作）：显式确认，走现有界面审批，口头同意不替代。
- 台账：宿主为每次修改记录 operation ID、目标、改动前后的值、对应的 delegation ID 和请求修订号。`undo` 由宿主按台账执行，而不是让模型回忆上一次改了什么；用户改口后，旧请求上的待确认项清空。
- 依据：写操作先复述再确认、不可逆动作显式确认、不要一刀切地事事确认（Realtime 提示指南）。显式确认费时而隐式确认把理解顺带说回，置信度越低确认越重（SLP3 附录 K）。动作本身也需要 grounding（SLP3 第 26 章）。operation ID 与 task revision、“yes” 的多义、改口后清除确认（Live 文档）。
- 代价：可撤销改动没有额外等待，多一句读回；显式确认多一轮对话和一次点击。
- 残余失败：用户没注意读回，错误改动会留到被发现为止；撤销只覆盖宿主记了台账的动作。

### 4. 交接时刻的轮次结束处理（确定性机制）

- 把「是否说完」的判断改到会话时间线上：以最后一个用户片段的 `end_ms` 与最新事件的时间线位置之差为准，到达时间只作兜底。现有 0.9 s 与 4 s 的取值落在各家文档给出的范围内（Gemini 约 800 ms，AssemblyAI `balanced` 上限 1280 ms，LiveKit 上限 3.0 s，Deepgram Flux 超时 5000 ms），不需要先动。
- 把「等」与「改」分开：只读工作在 delegation 到来时即可开始，修改类工具在等待窗口结束前由第 1 条的闸门挡住。这样多等的时间只落在会改页面的请求上。
- 交接后又来了新的用户片段：现在的处理是告知「上一项仍在执行，请稍后重说」。建议改为修订：若尚未执行任何修改类工具，宿主中止这一回合，把新旧片段合并为修订号加一的新请求重跑；若已经改了，就按第 3 条走撤销或追加。过期修订的结果一律丢弃。
- 可选的第二信号：在用户转写上挂一个 Decisions trigger，问「这句话说完了吗」，与 delegation 互为后备，并记录是哪个信号启动了工作。
- 依据：Live 没有轮次结束事件；用时间线而非到达时间；后面的话可能改变请求、要丢弃过期结果；task revision；Decisions trigger 的官方用法（Live 文档与 Cookbook）。各家都把静音阈值与语义判断、超时兜底组合起来，并承认是启发式。
- 代价：修订重跑会浪费一次后端启动；Decisions trigger 有额外的模型调用，费用与延迟未核实。
- 残余失败：用户停顿超过上限后再补半句，仍会被当成两个请求，由修订逻辑和撤销兜底。

### 5. 语音模型侧的提示词与模型对齐（提示级机制）

- 在 `gpt-live-1` 上按官方写法使用 `<|SpawnThinking|>`，或评估换到 `gpt-live-1.1`（自然语言委托、转写更准）。保留模板的三个标题，把「需要一句澄清才能听懂时不委托」「更正改变了已请求的工作时委托」写进 Delegation policy。
- 页面摘要用 `session.thinking.append`（`delegation_id: null`）在页面或选中元素变化时送一条短句，帮助语音模型判断「这个」指什么、该不该先问。
- 依据：见第二节 Live 部分。
- 代价：换模型要重跑第 6 条的回归集。
- 残余失败：全部取决于模型是否照做，所以排在确定性机制之后，只作为降低闸门拒绝次数的手段。

### 6. 稳定性度量（确定性机制，建议最先搭好，用来验证以上各项）

- 回归集：一组脚本化的口语请求，每条标注期望的动作类别（`ask`、`locate`、`change`、`undo`、`clarify`）、期望目标、期望改动、期望确认级别。必须包含：先问后改（presequence）、换对象不换属性、说到一半停顿再补、中途改口、指错对象后要求撤销、同音词、多个候选对象、助手说话时用户插话。
- 两层回放：
  - 文本层：把带 `start_ms`、`end_ms` 的转写片段和 delegation 事件按时间喂给 `LiveVoice.delegate` 之后的整条路径，后端 Agent 真实运行，页面用固定测试页。它不经过语音模型，覆盖第 1、3、4 条，可以放进现有的 `tests/live-voice*.ts`。
  - 音频层：用官方的会话 fork，从同一段参考对话出发重复喂同一句音频，覆盖语音模型的委托时机和第 2 条的转述。
- 指标：错误动作率（期望不改而改了，或目标、属性不对）；沿用率（改动值不在本次原话里）；不必要确认率；漏确认率；越界陈述率（助手说了模板之外的内容）；撤销成功率；从用户说完到第一句有效语音、到第一次修改的 P50 与 P90。语音模型不确定，每个场景跑多次，报告通过率和样本数。
- 依据：Live 评测指南的指标（任务完成、工具准确度、委托准确度、响应延迟、委托期间的静默），确定性检查加独立 LLM 评审，多次运行报 P50、P90；fork 用于从同一参考对话重复评测；guardrail 的测试清单要求分别验证动作阻断、应用状态、纠正话术和实际播放（Live 文档）。
- 代价：音频层按通话时长计费，适合发版前跑；文本层便宜，可以常跑。
- 残余失败：脚本集覆盖不到的说法；文本层看不到转写本身的错误，需要音频层和真实通话的抽查补上。

## 四、未能核实的内容

未能打开的页面（本文没有依赖它们的正文）：

- Clark & Schaefer 1989 的 Wiley 页面返回 403。grounding 的内容取自 SLP3 第 26 章对该文的转述，原文链接仅作出处。
- Skantze 关于对话系统轮次交替的综述（Computer Speech & Language，ScienceDirect）返回 403，未引用。
- Pipecat 的 Smart Turn 概览旧地址返回 404，改用 Speech Input & Turn Detection 页；Smart Turn 模型的内部参数和支持语言未核实。
- ACL Anthology 的 DSTC 条目页不含摘要，摘要取自论文 PDF，首句在文本提取时缺了开头。

只读到一部分的页面：

- Live API reference 全页约 40 万字符，只读了前 10 万：`session.start` 的字段列表和 client delegation 对象已读，服务端事件的完整 schema 没有读到。「Live 转写事件没有置信度字段」「Live 没有 turn detection 配置」这两点，依据是指南里的事件示例、已读到的字段列表和迁移指南的表述，不是对完整 reference 的逐项确认。
- GPT-Live 评测指南只读了 Metrics 一节；SOP Cookbook 只读了两节；Decisions 指南只读了 React to transcripts 一节。
- openai-realtime-agents 只读了 README，没有读源码；Chat-Supervisor 交接时具体传什么，README 没有写。

找过而没有找到一方依据的内容：

- 「结构化交接比自由文本交接错误更少」的量化证据。现有依据都是设计指导（Agents SDK 的结构化输出、Live 的结构化 guardrail 结果、后端更新标注类型），没有对比数据。
- 「按动作代价决定确认强度」在 SLP3 附录 K 里没有找到对应表述（那里只按 ASR 置信度分档）；本文的风险分级依据来自 OpenAI 的 Realtime 提示指南，不是 Live 的文档。Live 文档只说确认由应用执行，没有给分级方案。
- Live 的输入转写是否由独立 ASR 模型产生。Realtime 的文档明确写了，Live 的文档只写「转写可能有错」。
- 用置信度、logprobs 或 n-best 决定何时请用户重说的一方操作指导。Realtime 可以取 logprobs，但没有找到使用建议；Google 的页面只说明字段含义；Azure 的 n-best、Amazon Alexa 的确认与槽位机制本次没有查。
- Amazon Nova Sonic 的轮次检测参数。两个版本的概览页只有功能描述。
- LiveKit `EndpointingOptions` 与 `InterruptionOptions` 的参考页没有读，表中默认值取自 turn detector 页；多模态检测器的准确率数字不在该页。
- Deepgram Flux 的事件 payload、`TurnResumed` 的定义，以及 eager 模式的成本数字。
- 澄清请求与置信度确认的专门论文（如 Purver、Bohus & Rudnicky）和长距离 slot carryover 的后续论文没有取到原文，未引用。
- Decisions trigger 的费用和延迟，以及第三节各项机制的延迟代价，都没有测量。
- Athena 浏览器工具的只读、修改分类是按工具名做的划分，没有逐个对照实现。

## 五、已按本调研落地的改动（2026-11-22）

- 后端结果改由 `session.commentary.append` 送回，按句切块，前 700 字用于口述；超出部分才进 `session.thinking.append`。原先放在 commentary 里的那句指令已删除。
- 语音提示词改为官方模板的结构，并按 `gpt-live-1` 的要求使用 `Generate <|SpawnThinking|>` 写法。换到 `gpt-live-1.1` 时需改回自然语言写法。

- **提问不能修改页面（宿主闸门）。** 每句交给后端的话先由宿主判定是不是提问或确认（[voice-intent.ts](../src/shared/voice-intent.ts)，纯规则，不经模型）。判定为提问的这一轮，网页任务以只读方式启动：`edit`、`restyle`、`undo`、点击、填写、导航等一律被拒，`inspect`、`query` 和读取照常可用，被拒的调用不触及页面。判定只单独挑出明确的提问，其余都留给 Agent；因此判错的方向是"多问一句"，不是"多改一处"。
- **回归集。** [voice-intent.test.ts](../tests/voice-intent.test.ts) 收录 45 句口述请求及其预期类别，前 4 句取自 2026-11-22 出错的那次通话。两项指标分别统计：提问被放行（危险方向）0/21，请求被拦下（多说一遍）0/24。[voice-gate.test.ts](../tests/voice-gate.test.ts) 在真实浏览器会话里验证：提问轮次中四种修改调用全部被拒且页面不变，下一句明确要求后同一调用放行。新发现的误判句子加入回归集后再改规则。

这套保证的范围：**明确的提问不会改动页面**，由代码执行，不依赖模型。它不保证的：

- 明确要求修改时，改的对象和取值是否正确，仍取决于转写和 Agent；这一段是页面预览，可撤销。
- 规则没有覆盖的问法会被当作请求放行，落回提示级约束。回归集是 45 句，不是全部说法。
- 闸门管的是网页工具。Agent 的命令行、文件和沙箱工具不在其内。
- 转写把提问听成陈述时，判定跟着错。

尚未落地：第三节的分级确认与撤销台账、申报对象与取值的核对、按 `start_ms`/`end_ms` 判定说完。真实通话尚未验证。

## 六、打断与接力（2026-11-22）

官方依据：用户改口时，应用更新当前任务并忽略过期请求的结果；打断只停止说话，后端工作由应用处理（见第二节 Live 部分的 Interruptions 与 Keep updates accurate and useful）。

任务进行中又来了一句话时，宿主用规则判定它属于哪一种（[voice-intent.ts](../src/shared/voice-intent.ts) 的 `voiceRelay`），由 [live-voice.ts](../src/main/live-voice.ts) 的请求队列执行：

| 这句话 | 例子 | 处理 |
| --- | --- | --- |
| 改口 | 「不对，改成蓝色」 | 停止手头和排队中的任务；新任务带着被打断的要求启动，由 Agent 依据页面现状保留已做的、改掉冲突的、补完没做的 |
| 追加、其他问题 | 「再把标题加粗」「标题是什么颜色」 | 排在手头任务之后，不打断 |
| 喊停 | 「算了，停下吧」 | 停止全部，不启动新任务，告知已做的改动仍在 |
| 问进度 | 「好了吗」 | 直接回答正在处理哪一项，不打断 |

被取代的任务通过 `session.thinking.append` 告知语音模型，不走 commentary，因此不会被念出来。判定拿不准时归为改口。回归集 28 句，误判 0，其中"不该打断却打断了"0。

未验证：真实模型任务被中途停止后，新任务对"已做到哪一步"的判断质量；这取决于 Agent 读取页面现状，没有用真实通话测过。
