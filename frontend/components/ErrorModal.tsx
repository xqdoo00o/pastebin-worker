import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "./ui/index.js"
import type { ModalProps } from "./ui/index.js"
import { useCallback, useId, useState } from "react"
import { asError, ErrorWithTitle } from "../utils/errors.js"

export interface ErrorState {
  title: string
  content: string
  isOpen: boolean
}

type ErrorModalProps = Partial<Omit<ModalProps, "children" | "isOpen" | "onClose">>

interface ErrorModalViewProps extends ErrorModalProps {
  errorState: ErrorState
  onClose: () => void
  titleId: string
}

function ErrorModalView({ errorState, onClose, titleId, ...rest }: ErrorModalViewProps) {
  return (
    <Modal isOpen={errorState.isOpen} onClose={onClose} {...rest}>
      <ModalContent aria-labelledby={titleId}>
        <ModalHeader id={titleId} className="flex flex-col gap-1">
          {errorState.title}
        </ModalHeader>
        <ModalBody>
          <p>{errorState.content}</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="solid" onPress={onClose}>
            Close
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

export function useErrorModal() {
  const titleId = useId()
  const [errorState, setErrorState] = useState<ErrorState>({ isOpen: false, content: "", title: "" })

  const showModal = useCallback((title: string, content: string) => {
    setErrorState({ title, content, isOpen: true })
  }, [])

  const handleFailedResp = useCallback(
    async (defaultTitle: string, resp: Response) => {
      const statusText = resp.statusText === "error" ? "Unknown error" : resp.statusText
      const errText = (await resp.text()) || statusText
      showModal(defaultTitle, errText)
    },
    [showModal],
  )

  const handleError = useCallback(
    (defaultTitle: string, cause: unknown) => {
      const error = asError(cause)
      console.error(error)
      if (error instanceof ErrorWithTitle) {
        showModal(error.title, error.message)
      } else {
        showModal(defaultTitle, error.message)
      }
    },
    [showModal],
  )

  const onClose = useCallback(() => {
    setErrorState({ isOpen: false, content: "", title: "" })
  }, [])

  const errorModal = <ErrorModalView errorState={errorState} onClose={onClose} titleId={titleId} />

  return { errorModal, showModal, errorState, handleError, handleFailedResp }
}
