import type { ServerResponse } from 'node:http';
import { parse } from '../../packages/core/src/source.js';
import type { HostWorkspace } from './host-types.js';
import { recordBody, sendApiError, sendJson } from './http.js';

export function handleAuthoringRoute(
  pathname: string,
  method: string,
  body: unknown,
  ws: HostWorkspace,
  response: ServerResponse,
): boolean {
  if (pathname === '/api/structure') {
    if (method !== 'POST') {
      sendApiError(response, 405, 'method not allowed');
      return true;
    }
    const values = recordBody(body);
    const text = values.text ?? '';
    if (typeof text !== 'string') {
      sendApiError(response, 400, '操作が正しくありません');
      return true;
    }
    sendJson(response, 200, parse(text).to_json());
    return true;
  }

  if (pathname === '/api/new') {
    if (method !== 'POST') {
      sendApiError(response, 405, 'method not allowed');
      return true;
    }
    const values = recordBody(body);
    try {
      ws.new_deck(
        typeof values.name === 'string' ? values.name : '',
        typeof values.shelf === 'string' ? values.shelf : '',
        typeof values.theme === 'string' && values.theme.length > 0 ? values.theme : 'default',
        typeof values.from === 'string' && values.from.length > 0 ? values.from : null,
        typeof values.title === 'string' && values.title.length > 0 ? values.title : null,
      );
    } catch (error) {
      sendApiError(response, 400, error instanceof Error ? error.message : String(error));
      return true;
    }
    sendJson(response, 200, { deck: values.name });
    return true;
  }

  if (pathname === '/api/topics') {
    if (method !== 'POST') {
      sendApiError(response, 405, 'method not allowed');
      return true;
    }
    const values = recordBody(body);
    try {
      ws.new_topic(typeof values.name === 'string' ? values.name : '');
    } catch (error) {
      sendApiError(response, 400, error instanceof Error ? error.message : String(error));
      return true;
    }
    sendJson(response, 200, { topic: values.name });
    return true;
  }

  return false;
}
