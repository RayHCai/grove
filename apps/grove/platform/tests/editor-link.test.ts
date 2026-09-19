// Crossing to the editor: where a creator is sent, and which return addresses this origin will
// honour at all.

import { describe, expect, it } from 'vitest';
import { editorLink, editorUrl, returnToEditor } from '../src/editor/link';

const EDITOR = 'http://localhost:5176';

describe('where the editor is', () => {
    it('defaults to the port the editor serves on', () => {
        expect(editorUrl()).toBe(EDITOR);
    });
});

describe('the return address the editor sent', () => {
    it('takes one on the editor origin', () => {
        expect(returnToEditor(`${EDITOR}/?mode=code`)).toBe(`${EDITOR}/?mode=code`);
    });

    it('takes a relative one, against the editor rather than against this origin', () => {
        expect(returnToEditor('/deep')).toBe(`${EDITOR}/deep`);
    });

    /**
     * The one case that matters: a `return=` pointing anywhere else is an open redirect, and one
     * off this origin is a page dressed as Grove asking for a password.
     */
    it('refuses one on any other origin', () => {
        expect(returnToEditor('http://evil.example/steal')).toBeUndefined();
        expect(returnToEditor('https://localhost:5176/')).toBeUndefined();
        expect(returnToEditor('http://localhost:5177/')).toBeUndefined();
        // A credentialled URL is a different origin wearing the right host.
        expect(returnToEditor('http://user:pass@evil.example/')).toBeUndefined();
    });

    it('refuses a scheme that would run script rather than navigate', () => {
        expect(returnToEditor('javascript:alert(1)')).toBeUndefined();
        expect(returnToEditor('data:text/html,<script>1</script>')).toBeUndefined();
    });

    it('refuses something that is not an address at all', () => {
        expect(returnToEditor('http://')).toBeUndefined();
        expect(returnToEditor(undefined)).toBeUndefined();
    });
});

describe('the url a creator crosses on', () => {
    it('is the editor front door, carrying nothing', () => {
        const url = new URL(editorLink());
        expect(url.origin).toBe(EDITOR);
        expect(url.pathname).toBe('/');
        // Nothing of the session is on it: the cookie is what the browser carries across.
        expect(url.search).toBe('');
    });

    it('goes back to where the editor asked, untouched', () => {
        const url = new URL(editorLink(`${EDITOR}/?mode=code`));
        expect(url.searchParams.get('mode')).toBe('code');
    });

    it('falls back to the front door rather than honouring a foreign return address', () => {
        const url = new URL(editorLink('http://evil.example/steal'));
        expect(url.origin).toBe(EDITOR);
        expect(url.pathname).toBe('/');
    });
});
