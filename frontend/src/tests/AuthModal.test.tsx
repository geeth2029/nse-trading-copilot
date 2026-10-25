import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { AuthModal } from '../components/auth/AuthModal';
import * as api from '../services/api';
import type { UserRead } from '../services/api';

// --- Minimal Node DOM Mock for React 19 ---
class MockNode {}
class MockTextNode extends MockNode {
  nodeType = 3;
  nodeName = '#text';
  textContent: string;
  constructor(text: string = '') {
    super();
    this.textContent = text;
  }
}

class MockElement extends MockNode {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  ownerDocument = globalThis.document;
  style: Record<string, string> = {};
  childNodes: (MockElement | MockTextNode)[] = [];
  attributes: Record<string, string> = {};
  value: string = '';
  eventListeners: Record<string, ((e: unknown) => void)[]> = {};

  constructor(tag = 'div') {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
  }

  focus() {}
  blur() {}

  setAttribute(name: string, val: string) {
    this.attributes[name] = String(val);
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string) {
    return name in this.attributes;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  addEventListener(event: string, listener: (e: unknown) => void) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(listener);
  }

  removeEventListener(event: string, listener: (e: unknown) => void) {
    if (!this.eventListeners[event]) return;
    this.eventListeners[event] = this.eventListeners[event].filter((l) => l !== listener);
  }

  dispatchEvent(event: { type: string; target?: unknown }): boolean {
    event.target = this;
    const listeners = this.eventListeners[event.type] || [];
    for (const listener of listeners) {
      listener(event);
    }
    return true;
  }

  appendChild(child: MockElement | MockTextNode) {
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: MockElement | MockTextNode) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    return child;
  }

  insertBefore(child: MockElement | MockTextNode) {
    this.childNodes.push(child);
    return child;
  }

  get textContent(): string {
    return this.childNodes
      .map((c) => ('textContent' in c ? c.textContent : ''))
      .join('');
  }

  set textContent(text: string) {
    this.childNodes = [new MockTextNode(text)];
  }

  find(predicate: (el: MockElement) => boolean): MockElement | null {
    if (predicate(this)) return this;
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        const found = (child as MockElement).find(predicate);
        if (found) return found;
      }
    }
    return null;
  }

  findAll(predicate: (el: MockElement) => boolean): MockElement[] {
    const results: MockElement[] = [];
    if (predicate(this)) results.push(this);
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        results.push(...(child as MockElement).findAll(predicate));
      }
    }
    return results;
  }
}

const windowListeners: Record<string, ((e: unknown) => void)[]> = {};

function setupMockDom() {
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
  // @ts-expect-error test DOM listeners on window
  globalThis.addEventListener = (event: string, listener: (e: unknown) => void) => {
    if (!windowListeners[event]) windowListeners[event] = [];
    windowListeners[event].push(listener);
  };
  // @ts-expect-error test DOM listeners on window
  globalThis.removeEventListener = (event: string, listener: (e: unknown) => void) => {
    if (!windowListeners[event]) return;
    windowListeners[event] = windowListeners[event].filter((l) => l !== listener);
  };
  globalThis.dispatchEvent = (event: Event) => {
    const listeners = windowListeners[event.type] || [];
    for (const listener of listeners) listener(event);
    return true;
  };
  // @ts-expect-error test act flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // @ts-expect-error test DOM constructor stubs
  globalThis.Node = MockNode;
  // @ts-expect-error test DOM constructor stubs
  globalThis.Element = MockElement;
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLElement = MockElement;
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLIFrameElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLInputElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLTextAreaElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLSelectElement = class extends MockElement {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.HTMLDocument = function () {};
  // @ts-expect-error test DOM constructor stubs
  globalThis.Document = function () {};

  globalThis.document = {
    nodeType: 9,
    nodeName: '#document',
    ownerDocument: null,
    documentElement: new MockElement('html'),
    createElement: (tag: string) => new MockElement(tag),
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    createTextNode: (text: string) => new MockTextNode(text),
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  } as unknown as Document;
}

setupMockDom();

// Helper to access React synthetic event props directly
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProps(el: MockElement | null): Record<string, any> {
  if (!el) throw new Error('Element not found');
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactProps$')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (el as unknown as Record<string, any>)[key];
    }
  }
  throw new Error('React internal props not found on element');
}

function simulateChange(el: MockElement | null, value: string) {
  const props = getProps(el);
  if (props.onChange) {
    props.onChange({ target: { value } });
  }
}

async function changeInput(el: MockElement | null, value: string) {
  await act(async () => {
    simulateChange(el, value);
  });
}

function simulateClick(el: MockElement | null) {
  const props = getProps(el);
  if (props.onClick) {
    props.onClick({ target: el, currentTarget: el, preventDefault: () => {} });
  }
}

async function simulateSubmit(el: MockElement | null) {
  const props = getProps(el);
  if (props.onSubmit) {
    await props.onSubmit({ preventDefault: () => {} });
  }
}

describe('AuthModal Component', () => {
  let container: MockElement;
  let root: ReturnType<typeof createRoot>;

  const mockUser: UserRead = {
    id: 'user-200',
    email: 'newtrader@example.com',
    displayName: 'Scalp Master',
    createdAt: '2026-10-24T12:00:00Z',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'fetchCurrentUser').mockRejectedValue(
      new api.AuthenticationError('Authentication required.')
    );
    container = new MockElement('div');
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it('does not render dialog content when isOpen is false', async () => {
    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={false} onClose={() => {}} />
        </AuthProvider>
      );
    });

    const dialog = container.find((el) => el.getAttribute('role') === 'dialog');
    expect(dialog).toBeNull();
  });

  it('renders dialog with accessibility attributes when isOpen is true', async () => {
    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={() => {}} />
        </AuthProvider>
      );
    });

    const dialog = container.find((el) => el.getAttribute('role') === 'dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('auth-modal-title');
  });

  it('calls onClose when the close button is clicked', async () => {
    const handleClose = vi.fn();

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={handleClose} />
        </AuthProvider>
      );
    });

    const closeBtn = container.find(
      (el) => el.getAttribute('aria-label') === 'Close dialog'
    );
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      simulateClick(closeBtn);
    });

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed', async () => {
    const handleClose = vi.fn();

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={handleClose} />
        </AuthProvider>
      );
    });

    await act(async () => {
      globalThis.dispatchEvent({ type: 'keydown', key: 'Escape' } as unknown as Event);
    });

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('validates required email and password on client before submitting', async () => {
    const loginSpy = vi.spyOn(api, 'login');

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={() => {}} />
        </AuthProvider>
      );
    });

    const form = container.find((el) => el.tagName === 'FORM');
    expect(form).not.toBeNull();

    // Submit with empty inputs
    await act(async () => {
      await simulateSubmit(form);
    });

    // Client error should prevent API call
    expect(loginSpy).not.toHaveBeenCalled();

    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Email address is required.');
  });

  it('validates email format before submitting', async () => {
    const loginSpy = vi.spyOn(api, 'login');

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={() => {}} />
        </AuthProvider>
      );
    });

    const emailInput = container.find((el) => el.getAttribute('id') === 'auth-email-input');
    await changeInput(emailInput, 'invalid-email-format');

    const form = container.find((el) => el.tagName === 'FORM');
    await act(async () => {
      await simulateSubmit(form);
    });

    expect(loginSpy).not.toHaveBeenCalled();
    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert?.textContent).toContain('valid email address');
  });

  it('submits login form successfully with valid credentials and closes modal', async () => {
    const handleClose = vi.fn();
    const loginSpy = vi.spyOn(api, 'login').mockResolvedValue(mockUser);

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={handleClose} />
        </AuthProvider>
      );
    });

    const emailInput = container.find((el) => el.getAttribute('id') === 'auth-email-input');
    await changeInput(emailInput, 'trader@example.com');

    const passwordInput = container.find((el) => el.getAttribute('id') === 'auth-password-input');
    await changeInput(passwordInput, 'validpassword123');

    const form = container.find((el) => el.tagName === 'FORM');
    await act(async () => {
      await simulateSubmit(form);
    });

    expect(loginSpy).toHaveBeenCalledWith('trader@example.com', 'validpassword123');
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('displays error message when login fails with 401 credentials error', async () => {
    vi.spyOn(api, 'login').mockRejectedValue(
      new api.AuthenticationError('Invalid credentials.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={() => {}} />
        </AuthProvider>
      );
    });

    const emailInput = container.find((el) => el.getAttribute('id') === 'auth-email-input');
    await changeInput(emailInput, 'trader@example.com');

    const passwordInput = container.find((el) => el.getAttribute('id') === 'auth-password-input');
    await changeInput(passwordInput, 'wrongpassword');

    const form = container.find((el) => el.tagName === 'FORM');
    await act(async () => {
      await simulateSubmit(form);
    });

    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Invalid email or password');
  });

  it('enforces 12-character minimum password rule in Register mode', async () => {
    const registerSpy = vi.spyOn(api, 'register');

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={() => {}} initialMode="register" />
        </AuthProvider>
      );
    });

    const emailInput = container.find((el) => el.getAttribute('id') === 'auth-email-input');
    await changeInput(emailInput, 'trader@example.com');

    const passwordInput = container.find((el) => el.getAttribute('id') === 'auth-password-input');
    await changeInput(passwordInput, 'short9chars'); // < 12 characters

    const form = container.find((el) => el.tagName === 'FORM');
    await act(async () => {
      await simulateSubmit(form);
    });

    expect(registerSpy).not.toHaveBeenCalled();
    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert?.textContent).toContain('at least 12 characters');
  });

  it('handles registration-disabled (403) response gracefully with clear message', async () => {
    vi.spyOn(api, 'register').mockRejectedValue(
      new api.ApiError(403, 'Registration is disabled.')
    );

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={() => {}} initialMode="register" />
        </AuthProvider>
      );
    });

    const emailInput = container.find((el) => el.getAttribute('id') === 'auth-email-input');
    await changeInput(emailInput, 'newtrader@example.com');

    const passwordInput = container.find((el) => el.getAttribute('id') === 'auth-password-input');
    await changeInput(passwordInput, 'longsecurepassword123');

    const form = container.find((el) => el.tagName === 'FORM');
    await act(async () => {
      await simulateSubmit(form);
    });

    const alert = container.find((el) => el.getAttribute('role') === 'alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('New user registration is currently disabled');
  });

  it('registers successfully with display name and closes modal', async () => {
    const handleClose = vi.fn();
    const registerSpy = vi.spyOn(api, 'register').mockResolvedValue(mockUser);

    await act(async () => {
      root.render(
        <AuthProvider>
          <AuthModal isOpen={true} onClose={handleClose} initialMode="register" />
        </AuthProvider>
      );
    });

    const emailInput = container.find((el) => el.getAttribute('id') === 'auth-email-input');
    await changeInput(emailInput, 'newtrader@example.com');

    const displayNameInput = container.find((el) => el.getAttribute('id') === 'auth-display-name-input');
    await changeInput(displayNameInput, 'Scalp Master');

    const passwordInput = container.find((el) => el.getAttribute('id') === 'auth-password-input');
    await changeInput(passwordInput, 'longsecurepassword123');

    const form = container.find((el) => el.tagName === 'FORM');
    await act(async () => {
      await simulateSubmit(form);
    });

    expect(registerSpy).toHaveBeenCalledWith(
      'newtrader@example.com',
      'longsecurepassword123',
      'Scalp Master'
    );
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
