import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button, Card, Disclosure, Tabs } from '@heroui/react';
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ChartNoAxesCombinedIcon,
  ExternalLinkIcon,
  HelpCircleIcon,
  Mic01Icon,
  RefreshCwIcon,
} from '@hugeicons-pro/core-stroke-rounded';
import { Icon } from './ui';
import { ChoiceSelect } from './ChoiceSelect';
import { API_PRICING_SOURCE, costParts, type CostPart } from '../shared/usage-pricing';
import './usage-currency.css';
import './page-transitions.css';
import {
  groupUsage,
  groupVoice,
  filterUsage,
  filterVoice,
  summarizeUsage,
  summarizeVoice,
  usageDate,
  type UsageAmount,
  type UsageSnapshot,
  type TokenField,
} from '../shared/usage';

const labels: Record<TokenField, string> = {
  inputTokens: '输入',
  outputTokens: '输出',
  cachedInputTokens: '缓存读取',
  cacheWriteInputTokens: '缓存写入',
  reasoningOutputTokens: '推理输出',
  totalTokens: '总 Token',
};
const agentName = (value: string) => (value === 'codex' ? 'Codex CLI' : value);
const format = (number: number | null) =>
  number === null ? '未知' : number.toLocaleString('zh-CN');
const dollars = (value: number | null) =>
  value === null
    ? '—'
    : value > 0 && value < 0.0001
      ? '<$0.0001'
      : value.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
        });
const costLabels: Record<CostPart, string> = {
  input: '普通输入',
  output: '输出',
  cachedInput: '缓存读取',
  cacheWriteInput: '缓存写入',
};
function DollarAmount({ amount, partial = false }: { amount: UsageAmount; partial?: boolean }) {
  return (
    <span title={amount.value === null ? '缺少可核实的用量或费率' : undefined}>
      {dollars(amount.value)}
      {amount.value !== null && (amount.missing > 0 || partial) && (
        <small className="partial-marker">部分</small>
      )}
    </span>
  );
}
/** Call time as people say it: seconds under a minute, minutes and seconds above. */
const duration = (seconds: number | null) => {
  if (seconds === null) return '未知';
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours
    ? `${hours} 小时 ${minutes} 分`
    : minutes
      ? `${minutes} 分 ${whole % 60} 秒`
      : `${whole} 秒`;
};
function Amount({ amount }: { amount: UsageAmount }) {
  return (
    <span title={amount.missing ? `${amount.missing} 项缺少此字段` : '已采集值'}>
      {format(amount.value)}
      {amount.value !== null && amount.missing > 0 && (
        <small className="partial-marker">部分</small>
      )}
    </span>
  );
}
export function UsagePanel({ enter }: { enter?: 'a' | 'b' }) {
  const [data, setData] = useState<UsageSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [days, setDays] = useState('30');
  const [model, setModel] = useState('all');
  const [agent, setAgent] = useState('all');
  const [dimension, setDimension] = useState<'model' | 'agent' | 'date'>('model');
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await window.workbench.invoke<UsageSnapshot>('usage:snapshot'));
      setError('');
    } catch {
      setError('用量暂时无法读取，请重试。');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return window.workbench.onEvent((event) => {
      if (event.type === 'usage:updated') void refresh();
    });
  }, [refresh]);
  const records = useMemo(
    () =>
      filterUsage(data?.records ?? [], {
        days: days === 'all' ? undefined : Number(days),
        model: model === 'all' ? undefined : model,
        agent: agent === 'all' ? undefined : agent,
      }),
    [data, days, model, agent],
  );
  const total = summarizeUsage(records);
  const groups = groupUsage(records, dimension);
  const daily = groupUsage(records, 'date');
  const availableModels = [...new Set((data?.records ?? []).map((r) => r.model ?? 'unknown'))];
  const availableAgents = [...new Set((data?.records ?? []).map((r) => r.agent))];
  const chart = daily.slice(-30);
  const peak = Math.max(0.000001, ...chart.map((day) => day.cost.value ?? 0));
  const incomplete = total.missing > 0 || total.partial > 0;
  // Voice is not an Agent's work: it follows the time range and ignores the other two filters.
  const calls = useMemo(
    () => filterVoice(data?.voice ?? [], days === 'all' ? undefined : Number(days)),
    [data, days],
  );
  const voice = summarizeVoice(calls);
  const voiceDays = groupVoice(calls).slice(-30);
  const voicePeak = Math.max(1, ...voiceDays.map((day) => day.seconds.value ?? 0));
  const voiceIncomplete = voice.seconds.missing > 0 || voice.partial > 0;
  const costIncomplete = total.cost.missing > 0 || total.cost.partial > 0;
  const showDates = () => {
    flushSync(() => setDimension('date'));
    const scrollOptions = { behavior: 'instant', block: 'start', container: 'nearest' } as const;
    detailsHeading.current?.scrollIntoView(scrollOptions);
    detailsHeading.current?.focus({ preventScroll: true });
  };
  return (
    <section className="usage-panel t-page" data-enter={enter} aria-label="独立用量面板">
      <div className="usage-heading">
        <div>
          <h1>用量概览</h1>
          <p>本机 Athena 的任务记录</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="刷新用量"
          isDisabled={loading}
          onPress={() => void refresh()}
        >
          <Icon icon={RefreshCwIcon} size={15} className={loading ? 'spin' : ''} />
          刷新
        </Button>
      </div>
      <div className="usage-filters">
        <ChoiceSelect
          label="用量时间范围"
          value={days}
          onChange={setDays}
          options={[
            { value: '7', label: '最近 7 天' },
            { value: '30', label: '最近 30 天' },
            { value: 'all', label: '全部记录' },
          ]}
        />
        <ChoiceSelect
          label="按助手筛选"
          value={agent}
          onChange={setAgent}
          options={[
            { value: 'all', label: '全部助手' },
            ...availableAgents.map((id) => ({
              value: id,
              label: id === 'unknown' ? '助手未知' : agentName(id),
            })),
          ]}
        />
        <ChoiceSelect
          label="按模型筛选"
          value={model}
          onChange={setModel}
          options={[
            { value: 'all', label: '全部模型' },
            ...availableModels.map((id) => ({
              value: id,
              label: id === 'unknown' ? '模型未知或混合' : id,
            })),
          ]}
        />
        <span className="usage-timezone">
          日期按 {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </span>
      </div>
      {error && (
        <div className="usage-notice error" role="alert">
          <Icon icon={AlertCircleIcon} size={16} />
          {error}
          <Button size="sm" variant="ghost" onPress={() => void refresh()}>
            重试
          </Button>
        </div>
      )}
      {!data && !error ? (
        <div className="usage-empty" role="status">
          读取用量记录…
        </div>
      ) : (
        <>
          {(incomplete || costIncomplete) && (
            <div className="usage-notice" role="status">
              <Icon icon={HelpCircleIcon} size={16} />
              <span>
                {total.cost.missing > 0 ? `${total.cost.missing} 项任务暂无可用估算。` : ''}
                {total.cost.partial > 0 ? `${total.cost.partial} 项仅计已知部分。` : ''}
                {total.missing > 0 ? `${total.missing} 项未采集到用量。` : ''}
                合计仅含可核实的数据。
              </span>
            </div>
          )}
          <div className="usage-overview">
            <div className="usage-main-metric">
              <span>
                API 等价估算 <span className="usage-currency-label">USD</span>
              </span>
              <strong data-testid="usage-estimate">
                {total.cost.value === null ? '暂无估算' : dollars(total.cost.value)}
              </strong>
              <p>
                {total.cost.known} / {records.length} 项已估算{costIncomplete ? ' · 部分数据' : ''}
              </p>
              <p className="usage-billing-note">按 API 公开单价换算，不代表订阅实际扣费。</p>
            </div>
            <div className="usage-main-metric usage-secondary-metric usage-token-total">
              <span>已记录 Token</span>
              <strong data-testid="usage-total">{format(total.amounts.totalTokens.value)}</strong>
              <p>
                {records.length} 项任务{incomplete ? ' · 部分记录不完整' : ''}
              </p>
            </div>
            <div className="usage-main-metric usage-secondary-metric usage-io-total">
              <span>输入 / 输出 Token</span>
              <strong>
                <Amount amount={total.amounts.inputTokens} />
                <span className="usage-metric-divider"> / </span>
                <Amount amount={total.amounts.outputTokens} />
              </strong>
              <p>仅含已采集值，缺失字段保留为未知。</p>
            </div>
            <div className="usage-chart">
              <div className="usage-section-heading">
                <h2>每日估算 · USD</h2>
                <Button variant="ghost" size="sm" onPress={showDates}>
                  查看每日数据
                </Button>
              </div>
              {daily.some((day) => day.cost.value !== null) ? (
                <div
                  className="usage-daily-chart"
                  role="group"
                  aria-label="每日 API 等价估算，美元，最多显示最近 30 个有记录日期"
                >
                  {chart.map((day) => (
                    <button
                      key={day.key}
                      type="button"
                      className="usage-day"
                      aria-label={`${day.key}：${day.cost.value === null ? '暂无估算' : dollars(day.cost.value)}${day.cost.missing || day.cost.partial ? '，部分数据' : ''}`}
                      title={`${day.key} · ${day.cost.value === null ? '暂无估算' : dollars(day.cost.value)} · API 等价估算`}
                      onClick={showDates}
                    >
                      <span className="usage-day-value">
                        {day.cost.value === null
                          ? '?'
                          : chart.length < 8
                            ? dollars(day.cost.value)
                            : ''}
                      </span>
                      <span
                        className="usage-day-bar"
                        style={{
                          height: `${day.cost.value === null || day.cost.value === 0 ? 0 : Math.max(1, (day.cost.value / peak) * 130)}px`,
                        }}
                      />
                      <span className="usage-day-label">{day.key.slice(5)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="usage-chart-empty">
                  <Icon icon={ChartNoAxesCombinedIcon} size={28} />
                  <span>此范围暂无可核实的费用估算</span>
                </div>
              )}
            </div>
          </div>
          {daily.length > 30 && (
            <p className="panel-note">图示最近 30 个有记录日期，全部日期可在明细中查看。</p>
          )}
          <dl className="usage-metrics">
            {costParts.map((field) => (
              <Card key={field} className="usage-kpi">
                <Card.Header>
                  <dt className="kpi__title">{costLabels[field]}</dt>
                </Card.Header>
                <Card.Content>
                  <dd className="usage-kpi-value">
                    <DollarAmount amount={total.cost.parts[field]} />
                  </dd>
                </Card.Content>
                <Card.Footer className="kpi__footer">
                  <Amount amount={total.cost.tokens[field]} /> Token
                </Card.Footer>
              </Card>
            ))}
          </dl>
          <section className="usage-voice" aria-labelledby="usage-voice-title">
            <div className="usage-section-heading">
              <h2 id="usage-voice-title">
                <Icon icon={Mic01Icon} size={15} />
                Live 语音
              </h2>
              <span className="usage-voice-note">按通话时长计费，与上面的 Token 估算分开</span>
            </div>
            {calls.length ? (
              <div className="usage-voice-body">
                <dl className="usage-voice-metrics">
                  <div>
                    <dt>通话时长</dt>
                    <dd data-testid="usage-voice-time">
                      {duration(voice.seconds.value)}
                      {voice.seconds.value !== null && voiceIncomplete && (
                        <small className="partial-marker">部分</small>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>通话次数</dt>
                    <dd data-testid="usage-voice-calls">{voice.calls}</dd>
                  </div>
                  <div>
                    <dt>平均每次</dt>
                    <dd>
                      {duration(
                        voice.seconds.value === null
                          ? null
                          : voice.seconds.value / voice.seconds.known,
                      )}
                    </dd>
                  </div>
                </dl>
                <div
                  className="usage-daily-chart usage-voice-chart"
                  role="group"
                  aria-label="每日通话时长，最多显示最近 30 个有通话的日期"
                >
                  {voiceDays.map((day) => (
                    <div
                      key={day.key}
                      className="usage-day"
                      role="img"
                      aria-label={`${day.key}：${day.calls} 次通话，${duration(day.seconds.value)}`}
                      title={`${day.key} · ${day.calls} 次 · ${duration(day.seconds.value)}`}
                    >
                      <span className="usage-day-value">
                        {day.seconds.value === null
                          ? '?'
                          : voiceDays.length < 8
                            ? duration(day.seconds.value)
                            : ''}
                      </span>
                      <span
                        className="usage-day-bar"
                        style={{
                          height: `${day.seconds.value ? Math.max(1, (day.seconds.value / voicePeak) * 72) : 0}px`,
                        }}
                      />
                      <span className="usage-day-label">{day.key.slice(5)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="usage-voice-empty">
                {data?.voice?.length
                  ? '这个时间范围内没有语音通话。'
                  : '还没有语音通话。在输入框点麦克风，就可以直接和 Athena 说话。'}
              </p>
            )}
            {calls.length > 0 && (
              <p className="panel-note">
                时长取自 OpenAI 在通话中报告的计费秒数，静音期间也计时。
                {voice.seconds.missing > 0 ? `${voice.seconds.missing} 次通话没有报告时长，未计入。` : ''}
                {voice.partial > 0 ? `${voice.partial} 次通话未正常收尾，只计到最后一次报告。` : ''}
                这里不估算金额，费用以 OpenAI 账单为准。
              </p>
            )}
          </section>
          <div id="usage-details" className="usage-details">
            <div className="usage-section-heading">
              <h2 ref={detailsHeading} tabIndex={-1}>
                明细
              </h2>
              <Tabs
                variant="secondary"
                selectedKey={dimension}
                onSelectionChange={(key) => setDimension(key as typeof dimension)}
                aria-label="用量分组"
              >
                <Tabs.ListContainer>
                  <Tabs.List aria-label="统计维度">
                    {(['model', 'agent', 'date'] as const).map((key) => (
                      <Tabs.Tab key={key} id={key}>
                        {key === 'model' ? '模型' : key === 'agent' ? '助手' : '日期'}
                        <Tabs.Indicator />
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>
            </div>
            {groups.length ? (
              <div className="usage-table-scroll">
                <table className="usage-table">
                  <caption className="sr-only">
                    按{dimension === 'date' ? '日期' : dimension === 'agent' ? '助手' : '模型'}
                    汇总用量
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">
                        {dimension === 'model' ? '模型' : dimension === 'agent' ? '助手' : '日期'}
                      </th>
                      <th scope="col">估算 USD</th>
                      <th scope="col">任务</th>
                      {(
                        [
                          'inputTokens',
                          'outputTokens',
                          'cachedInputTokens',
                          'cacheWriteInputTokens',
                          'totalTokens',
                        ] as TokenField[]
                      ).map((field) => (
                        <th key={field} scope="col">
                          {labels[field]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <tr key={group.key}>
                        <th scope="row">
                          {agentName(group.key)}
                          {(group.missing > 0 ||
                            group.partial > 0 ||
                            group.cost.missing > 0 ||
                            group.cost.partial > 0) && <small>数据不完整</small>}
                        </th>
                        <td className="usage-table-cost">
                          <DollarAmount amount={group.cost} partial={group.cost.partial > 0} />
                        </td>
                        <td>{group.records}</td>
                        {(
                          [
                            'inputTokens',
                            'outputTokens',
                            'cachedInputTokens',
                            'cacheWriteInputTokens',
                            'totalTokens',
                          ] as TokenField[]
                        ).map((field) => (
                          <td key={field}>
                            <Amount amount={group.amounts[field]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="usage-empty">
                <Icon icon={ChartNoAxesCombinedIcon} size={30} />
                <strong>暂无用量记录</strong>
                <p>运行任务后，可在这里查看用量和 API 等价估算。</p>
                {(model !== 'all' || agent !== 'all') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      setAgent('all');
                      setModel('all');
                    }}
                  >
                    清除筛选
                  </Button>
                )}
              </div>
            )}
          </div>
          <Disclosure className="usage-pricing-details">
            <Disclosure.Heading>
              <Disclosure.Trigger>
                估算依据与单价 <Icon icon={ArrowDown01Icon} size={14} />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body>
                <p>
                  统一按标准档、短上下文（单次输入 ≤272K）、30m
                  缓存公开单价换算；未含长上下文、加速、区域及工具等附加费用。这里展示可比的 API
                  价值，不是实际账单。
                </p>
                <p>
                  普通输入已扣除缓存读取和写入；输出已包含推理 Token。缺少必要字段的部分不计价。
                </p>
                {total.cost.pricing.length > 0 && (
                  <div className="usage-table-scroll">
                    <table className="usage-table usage-price-table">
                      <caption>单价：USD / 百万 Token</caption>
                      <thead>
                        <tr>
                          <th scope="col">模型 / 价格核验日</th>
                          {costParts.map((part) => (
                            <th key={part} scope="col">
                              {costLabels[part]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {total.cost.pricing.map((price) => (
                          <tr key={`${price.version}/${price.model}`}>
                            <th scope="row">
                              {price.model}
                              <small>{price.verifiedAt}</small>
                            </th>
                            {costParts.map((part) => (
                              <td key={part}>{dollars(price.rates[part])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <Button
                  className="usage-price-source"
                  size="sm"
                  variant="ghost"
                  onPress={() => {
                    void window.workbench
                      .invoke('shell:openExternal', { url: API_PRICING_SOURCE })
                      .catch(() => setError('价格来源暂时无法打开，请稍后重试。'));
                  }}
                >
                  <Icon icon={ExternalLinkIcon} size={13} />
                  OpenAI 官方价格
                </Button>
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
          <div className="usage-footnote">
            <p>
              输入包含缓存读取；各缓存项属于输入的明细，不重复加入总 Token。未返回的字段显示为未知。
            </p>
            <p>
              {data ? `用量采集始于 ${usageDate(data.since)}。` : ''}
              旧任务没有可信用量时保留为缺失。
              {total.amounts.reasoningOutputTokens.value !== null
                ? `已记录推理输出 ${format(total.amounts.reasoningOutputTokens.value)} Token（计入输出）。`
                : ''}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
