/** Carries an HTTP status through the state layer so handlers stay thin. */
export class StateError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'StateError';
    this.status = status;
  }
}
