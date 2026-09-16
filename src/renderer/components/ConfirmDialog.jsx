import { HiOutlineExclamationTriangle } from "react-icons/hi2";

import Button from "./Button";
import Modal from "./Modal";

/**
 * ConfirmDialog.
 *
 * Replaces the native `window.confirm` the app used for its irreversible
 * actions (deleting a wallet, removing a token). A themed dialog can explain
 * the consequence, name what is being destroyed, and show a pending state while
 * the action runs — none of which a browser confirm box can do.
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  detail,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      dismissible={!busy}
      size="max-w-sm"
      icon={
        tone === "danger" ? (
          <HiOutlineExclamationTriangle className="size-4" />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {description ? <p className="nc-body">{description}</p> : null}

        {detail ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
            {detail}
          </div>
        ) : null}

        <div className="flex gap-2 pt-1">
          <Button
            variant="secondary"
            size="block"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "default"}
            size="block"
            onClick={onConfirm}
            loading={busy}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
