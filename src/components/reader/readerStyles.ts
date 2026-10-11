/* Icon buttons that live inside a glass capsule: no material of their own
   (glass never sits on glass), just a fill on hover and a give on press. A
   40px circle in a capsule with 4px padding keeps the corners concentric. */
export const TOOL_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text-secondary transition-[background-color,color,transform] duration-200 hover:bg-text-primary/[0.07] hover:text-text-primary active:scale-95";

/** Every toolbar popover shares one glass shape and opening motion. */
export const POPOVER_CLASS = "glass-pop animate-scale-in origin-top-right rounded-[26px] p-4";
