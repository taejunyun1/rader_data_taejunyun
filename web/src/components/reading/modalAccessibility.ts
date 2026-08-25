import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE_SELECTOR = "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function setSiblingsHidden(layer: HTMLElement): () => void {
  const siblings = Array.from(globalThis.document.body.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer);
  const previous = siblings.map((element) => ({
    element,
    ariaHidden: element.getAttribute("aria-hidden"),
    inert: element.hasAttribute("inert"),
  }));

  for (const { element } of previous) {
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("inert", "");
  }

  return () => {
    for (const { element, ariaHidden, inert } of previous) {
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);

      if (!inert) element.removeAttribute("inert");
    }
  };
}

interface ModalAccessibilityOptions {
  open: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  layerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  getInitialFocusTarget?: () => HTMLElement | null;
  initialFocusDeps?: ReadonlyArray<unknown>;
}

export function useModalAccessibility({
  open,
  dialogRef,
  layerRef,
  onClose,
  getInitialFocusTarget,
  initialFocusDeps = [],
}: ModalAccessibilityOptions) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const initialFocusTargetRef = useRef(getInitialFocusTarget);
  initialFocusTargetRef.current = getInitialFocusTarget;

  useEffect(() => {
    if (!open) return;
    const layer = layerRef.current;
    if (!layer) return;

    returnFocusRef.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
    const previousOverflow = globalThis.document.body.style.overflow;
    const restoreSiblings = setSiblingsHidden(layer);
    globalThis.document.body.style.overflow = "hidden";

    return () => {
      restoreSiblings();
      globalThis.document.body.style.overflow = previousOverflow;
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [dialogRef, layerRef, open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const initialTarget = initialFocusTargetRef.current?.() ?? focusableElements(dialog)[0] ?? dialog;
    initialTarget.focus();
  }, [dialogRef, open, ...initialFocusDeps]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab" || !dialogRef.current) return;

    const elements = focusableElements(dialogRef.current);
    if (elements.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }

    const first = elements[0]!;
    const last = elements[elements.length - 1]!;
    if (event.shiftKey && globalThis.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && globalThis.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return { handleKeyDown };
}
