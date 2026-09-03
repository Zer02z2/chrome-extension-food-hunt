// The wire protocol between the content script and the camera frame.
//
// The camera frame is an extension page the content script iframes into the
// host page. It cannot be reached with chrome.runtime messaging (that would
// mean a round trip through the service worker, and ImageBitmap does not
// survive it), so the two talk over a MessageChannel instead: cheap, and the
// port is invisible to the host page's own scripts.
//
// Handing the port over is the one message that has to travel by
// window.postMessage, where the host page could impersonate either side. The
// content script therefore mints a nonce, passes it to the frame in the URL
// fragment — which is cross-origin-opaque, so page script cannot read it back
// off the iframe element — and the frame ignores any handshake without it.

/** Query key carrying the handshake nonce in the camera frame's URL fragment. */
export const HEAD_TOKEN_KEY = 't';

/** window.postMessage envelope that delivers the MessagePort. */
export type HeadHandshake = {
  type: 'foodmask:head-port';
  token: string;
};

export function isHeadHandshake(v: unknown): v is HeadHandshake {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as HeadHandshake).type === 'foodmask:head-port' &&
    typeof (v as HeadHandshake).token === 'string'
  );
}

/** content script -> camera frame */
export type HeadCommand =
  | { type: 'start' } // open the camera and start emitting frames
  | { type: 'stop' }; // release the camera; the indicator light goes out

/** camera frame -> content script */
export type HeadEvent =
  | { type: 'frame'; bitmap: ImageBitmap } // one head cutout, cropped tight
  | { type: 'state'; state: 'loading' | 'live' | 'idle' }
  | { type: 'error'; message: string };
