import { useLayoutEffect } from "react";

type Props = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "rows" | "className"> & {
  value: string;
  inputRef: React.RefObject<HTMLTextAreaElement>;
};

export const ComposerTextarea = ({ value, inputRef, onKeyDown, ...rest }: Props) => {
  useLayoutEffect(() => {
    const box = inputRef.current;
    if (box === null) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [inputRef, value]);

  return (
    <textarea
      {...rest}
      ref={inputRef}
      rows={1}
      value={value}
      className="composer-textarea"
      onKeyDown={(e) => {
        onKeyDown?.(e);
        // 输入法组字时的回车是上屏。Safari 组字刚结束的那下回车 isComposing 已经是 false，只剩 keyCode 229 认得出。
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.currentTarget.form?.requestSubmit();
      }}
    />
  );
};
