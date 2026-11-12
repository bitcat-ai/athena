import { Button, Modal } from '@heroui/react';
import { ArrowUpRight01Icon, File01Icon, FolderOpenIcon } from '@hugeicons-pro/core-stroke-rounded';
import { useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from './ui';
import './prd-document.css';

export function PrdArtifact({
  conversationId,
  messageId,
  eventId,
  onAction,
}: {
  conversationId: string;
  messageId: string;
  eventId: string;
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
}) {
  const [document, setDocument] = useState<{ name: string; text: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const target = { conversationId, messageId, eventId };
  const title = document?.text.match(/^#\s+(.+)$/m)?.[1] ?? '需求文档';
  const body = (document?.text ?? '').replace(/^#\s+.+\r?\n/, '');
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]);
  const sections = body.split(/(?=^##\s)/m);
  const open = async () => {
    setError('');
    setLoading(true);
    try {
      const value = await onAction<{ name: string; text: string }>('artifact:read', target);
      if (value) setDocument(value);
      else setError('暂时无法打开需求文档，请重试。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法打开需求文档');
    } finally {
      setLoading(false);
    }
  };
  const markdown = (text: string) => (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: ({ alt }) => <span>{alt}</span>,
        a: ({ children, href }) => (
          <span>
            {children} <small className="prd-source-url">{href}</small>
          </span>
        ),
      }}
    >
      {text}
    </Markdown>
  );
  return (
    <>
      <Button
        variant="secondary"
        className="prd-artifact"
        onPress={() => void open()}
        isDisabled={loading}
        aria-label="查看 PRD"
      >
        <span className="prd-artifact-icon">
          <Icon icon={File01Icon} size={22} />
        </span>
        <span className="prd-artifact-copy">
          <span>PRD</span>
          <strong>{loading ? '正在打开…' : '需求文档'}</strong>
          <small>功能范围、验收条件与参考资料</small>
        </span>
        <Icon icon={ArrowUpRight01Icon} size={16} />
      </Button>
      {error && (
        <p role="alert" className="panel-error">
          {error}
        </p>
      )}
      <Modal.Backdrop
        isOpen={!!document}
        onOpenChange={(open) => {
          if (!open) setDocument(undefined);
        }}
      >
        <Modal.Container size="cover" className="prd-document-container">
          <Modal.Dialog aria-label="需求文档" className="prd-document-dialog">
            <Modal.CloseTrigger />
            <Modal.Header className="prd-document-header">
              <span className="prd-document-eyebrow">
                PRD <span>·</span> 需求文档
              </span>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="prd-document-layout">
              <nav aria-label="文档目录" className="prd-document-outline">
                <span>目录</span>
                {headings.map((heading, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => {
                      const section =
                        content.current?.querySelectorAll<HTMLElement>('[data-prd-section]')[index];
                      section?.scrollIntoView({ block: 'start' });
                      section?.focus({ preventScroll: true });
                    }}
                  >
                    <small>{String(index + 1).padStart(2, '0')}</small>
                    {heading}
                  </button>
                ))}
              </nav>
              <div ref={content} className="prd-document-content">
                {sections.map((section, index) => {
                  const heading = section.match(/^##\s+(.+)/)?.[1];
                  return (
                    <section
                      key={index}
                      data-prd-section={heading ? '' : undefined}
                      tabIndex={heading ? -1 : undefined}
                    >
                      {heading === '页面预览证据' ? (
                        <details className="prd-evidence">
                          <summary>页面预览证据</summary>
                          {markdown(section.replace(/^##\s+.+\n/, ''))}
                        </details>
                      ) : (
                        markdown(section)
                      )}
                    </section>
                  );
                })}
              </div>
            </Modal.Body>
            <Modal.Footer className="prd-document-footer">
              <Button variant="ghost" onPress={() => void onAction('artifact:reveal', target)}>
                <Icon icon={FolderOpenIcon} size={16} />在 Finder 中显示
              </Button>
              <Button variant="secondary" onPress={() => setDocument(undefined)}>
                关闭
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
