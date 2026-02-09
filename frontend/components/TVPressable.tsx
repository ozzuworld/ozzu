import { useState, useCallback } from "react";
import { Pressable, type PressableProps } from "react-native";

interface TVPressableProps extends PressableProps {
  className?: string;
  focusClassName?: string;
}

export function TVPressable({
  className = "",
  focusClassName = "border-blue-400 scale-105",
  children,
  ...props
}: TVPressableProps) {
  const [focused, setFocused] = useState(false);

  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);

  return (
    <Pressable
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={`${className} ${focused ? focusClassName : ""}`}
      {...props}
    >
      {children}
    </Pressable>
  );
}
