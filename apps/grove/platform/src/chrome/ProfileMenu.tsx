import { useId, useRef, useState } from 'react';
import { Menu, MenuItem, UserIcon, menuItemClass } from '@grove/ui';
import { Link } from '../router/Link';
import { useSession } from '../session/SessionProvider';

/**
 * The profile icon and the small menu it drops.
 *
 * The pages are links, so each can be opened in another tab like any other; signing out is the
 * one row that does something rather than going somewhere.
 */
export function ProfileMenu(): React.JSX.Element {
    const { signOut } = useSession();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const toggle = useRef<HTMLButtonElement>(null);
    const menuId = useId();

    return (
        <div className="profilemenu" ref={root}>
            <button
                ref={toggle}
                type="button"
                className="profilemenu__toggle"
                aria-label="Account"
                title="Account"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={menuId}
                onClick={() => setOpen((was) => !was)}
            >
                <UserIcon size={22} />
            </button>

            <Menu
                id={menuId}
                label="Account"
                className="profilemenu__panel"
                open={open}
                within={root}
                onClose={(reason) => {
                    setOpen(false);
                    if (reason === 'escape') toggle.current?.focus();
                }}
            >
                <Link
                    to={{ at: 'profile' }}
                    role="menuitem"
                    className={menuItemClass()}
                    onClick={() => setOpen(false)}
                >
                    Profile
                </Link>
                <Link
                    to={{ at: 'games' }}
                    role="menuitem"
                    className={menuItemClass()}
                    onClick={() => setOpen(false)}
                >
                    Games
                </Link>
                <MenuItem
                    onClick={() => {
                        setOpen(false);
                        void signOut();
                    }}
                >
                    Sign out
                </MenuItem>
            </Menu>
        </div>
    );
}
