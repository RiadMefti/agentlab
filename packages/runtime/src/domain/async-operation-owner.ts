/** Retains an asynchronous adapter operation until it settles, even if its caller stops waiting. */
export interface AsyncOperationOwner {
  own<Output>(operation: Promise<Output>): Promise<Output>;
}
