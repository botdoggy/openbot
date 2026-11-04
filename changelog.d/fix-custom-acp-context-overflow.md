### Fixed

- A custom ACP session that fails because it outgrew the model context is now closed and replaced
  once with a new session that receives the OpenBot history, so the next turn is not guaranteed to
  fail the same way. Other custom ACP failures keep their session and still fail without a retry.
