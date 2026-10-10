import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { AssistantSnapshot } from "../../../shared/assistant";
import "./AssistantConversationMap.css";

type Message = AssistantSnapshot["messages"][number];

function messagePreview(message: Message) {
  return (
    message.text.trim().replace(/\s+/g, " ").slice(0, 160) ||
    "No response text yet"
  );
}

export function AssistantConversationMap({
  messages,
  listRef,
  mobile,
  onLayout,
  onNavigate,
}: {
  messages: Message[];
  listRef: RefObject<HTMLDivElement | null>;
  mobile: boolean;
  onLayout: () => void;
  onNavigate: () => void;
}) {
  const [horizontal, setHorizontal] = useState(mobile);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const waveRef = useRef<HTMLDivElement>(null);
  const messageIds = JSON.stringify(messages.map((message) => message.id));

  useLayoutEffect(onLayout, [horizontal, onLayout]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const sections = Array.from(
      list.querySelectorAll<HTMLElement>(".assistant-message"),
    );
    let frame = 0;
    const measure = () => {
      frame = 0;
      setHorizontal(mobile || list.parentElement!.clientWidth <= 600);
      const viewport = list.getBoundingClientRect();
      const visible =
        viewport.height > 0 && viewport.width > 0
          ? sections
              .filter((section) => {
                const rect = section.getBoundingClientRect();
                return rect.bottom > viewport.top && rect.top < viewport.bottom;
              })
              .map((section) => section.dataset.messageId!)
          : [];
      setVisibleIds((current) =>
        current.length === visible.length &&
        current.every((id, index) => id === visible[index])
          ? current
          : visible,
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const observer = new window.ResizeObserver(schedule);
    observer.observe(list);
    // Streaming text and expanded action cards can resize messages without
    // changing the fixed-height conversation viewport.
    sections.forEach((section) => observer.observe(section));
    list.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", schedule);
      window.cancelAnimationFrame(frame);
    };
  }, [listRef, messageIds, mobile]);

  const currentIndex = Math.max(
    0,
    messages.findIndex((message) => visibleIds.includes(message.id)),
  );
  const hoveredIndex = messages.findIndex(
    (message) => message.id === hoveredId,
  );
  const previewIndex =
    hoveredIndex >= 0 ? hoveredIndex : keyboardFocus ? currentIndex : -1;
  const preview = messages[previewIndex];

  const indexAt = (clientX: number, clientY: number) => {
    const rect = waveRef.current!.getBoundingClientRect();
    const offset = horizontal ? clientX - rect.left : clientY - rect.top;
    const length = horizontal ? rect.width : rect.height;
    return Math.max(
      0,
      Math.min(
        messages.length - 1,
        Math.floor((offset / Math.max(1, length)) * messages.length),
      ),
    );
  };

  const navigate = (index: number) => {
    const list = listRef.current;
    const message = messages[index];
    if (!list || !message) return;
    const section = Array.from(
      list.querySelectorAll<HTMLElement>(".assistant-message"),
    ).find((element) => element.dataset.messageId === message.id);
    if (!section) return;
    onNavigate();
    // Jump only this scroll container, in CSS pixels even when the UI is zoomed.
    // An immediate jump also avoids re-enabling stream following mid-animation.
    const viewport = list.getBoundingClientRect();
    const scale = list.offsetHeight ? viewport.height / list.offsetHeight : 1;
    list.scrollTop +=
      (section.getBoundingClientRect().top - viewport.top) / (scale || 1) - 12;
    setHoveredId(message.id);
  };

  if (!messages.length) return null;

  return (
    <div
      className={`assistant-conversation-map${horizontal ? " is-horizontal" : ""}`}
    >
      <div
        ref={waveRef}
        className="assistant-conversation-wave"
        style={{ "--message-count": messages.length } as CSSProperties}
        role="slider"
        tabIndex={0}
        aria-label="Ranger conversation navigation"
        aria-orientation={horizontal ? "horizontal" : "vertical"}
        aria-valuemin={1}
        aria-valuemax={messages.length}
        aria-valuenow={currentIndex + 1}
        aria-valuetext={`${messages[currentIndex].role === "user" ? "You" : "Ranger"}: ${messagePreview(messages[currentIndex])}`}
        onFocus={(event) =>
          setKeyboardFocus(event.currentTarget.matches(":focus-visible"))
        }
        onBlur={() => {
          setKeyboardFocus(false);
          setHoveredId(null);
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== "touch")
            setHoveredId(messages[indexAt(event.clientX, event.clientY)].id);
        }}
        onPointerLeave={() => setHoveredId(null)}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          setKeyboardFocus(false);
          navigate(indexAt(event.clientX, event.clientY));
        }}
        onKeyDown={(event) => {
          const start = previewIndex >= 0 ? previewIndex : currentIndex;
          const index =
            event.key === (horizontal ? "ArrowLeft" : "ArrowUp")
              ? start - 1
              : event.key === (horizontal ? "ArrowRight" : "ArrowDown")
                ? start + 1
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? messages.length - 1
                    : null;
          if (index === null) return;
          event.preventDefault();
          setKeyboardFocus(true);
          navigate(Math.max(0, Math.min(messages.length - 1, index)));
        }}
      >
        {messages.map((message, index) => {
          const visible = visibleIds.includes(message.id);
          const baseWidth = visible ? 16 : message.role === "user" ? 12 : 8;
          const width =
            previewIndex < 0
              ? baseWidth
              : Math.max(baseWidth, 22 - Math.abs(previewIndex - index) * 4);
          return (
            <span
              key={message.id}
              className={`assistant-conversation-mark is-${message.role}${visible ? " is-visible" : ""}`}
              data-message-id={message.id}
              style={{ "--mark-width": `${width}px` } as CSSProperties}
              aria-hidden="true"
            />
          );
        })}
        {preview ? (
          <div
            className="assistant-conversation-preview"
            role="tooltip"
            style={
              {
                "--preview-position": `${((previewIndex + 0.5) / messages.length) * 100}%`,
              } as CSSProperties
            }
          >
            <strong>
              {preview.role === "user" ? "You" : "Ranger"}
              <span>
                {previewIndex + 1} / {messages.length}
              </span>
            </strong>
            <span>{messagePreview(preview)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
