// The script inside a local run's frame. It is inlined into the document as text, so it imports
// nothing and is the only code in there that is not the creator's.
//
// The frame is sandboxed without `allow-same-origin`, which gives it an origin of its own: it can
// reach no storage, no cookie and no DOM of the editor's, and this channel is the whole of what
// crosses between them.

(function () {
    'use strict';

    var TO_EDITOR = 'grove-run';
    var FROM_EDITOR = 'grove-editor';
    var DEPTH = 3;

    function post(message) {
        message.source = TO_EDITOR;
        parent.postMessage(message, '*');
    }

    // ---- what a value looks like in the console pane

    function render(value, depth) {
        if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value);
        if (value === null || value === undefined) return String(value);
        if (typeof value === 'function') return 'function ' + (value.name || '(anonymous)');
        if (value instanceof Error) return value.stack || value.name + ': ' + value.message;
        if (typeof value !== 'object') return String(value);
        if (depth >= DEPTH) return Array.isArray(value) ? '[…]' : '{…}';

        if (Array.isArray(value)) {
            return (
                '[' +
                value
                    .map(function (item) {
                        return render(item, depth + 1);
                    })
                    .join(', ') +
                ']'
            );
        }
        var parts = [];
        for (var key in value) {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                parts.push(key + ': ' + render(value[key], depth + 1));
            }
        }
        return '{' + parts.join(', ') + '}';
    }

    function line(level, args) {
        var text;
        try {
            text = Array.prototype.map
                .call(args, function (value) {
                    return render(value, 0);
                })
                .join(' ');
        } catch {
            // A getter that throws must not take the run down with it.
            text = '[a value could not be rendered]';
        }
        post({ type: 'log', level: level, text: text });
    }

    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
        var through = console[level];
        console[level] = function () {
            line(level === 'debug' ? 'log' : level, arguments);
            if (typeof through === 'function') through.apply(console, arguments);
        };
    });

    window.addEventListener('error', function (event) {
        post({ type: 'error', text: event.message + ' (' + (event.lineno || 0) + ')' });
    });
    window.addEventListener('unhandledrejection', function (event) {
        post({ type: 'error', text: 'unhandled rejection: ' + render(event.reason, 0) });
    });

    // ---- pause
    //
    // A page cannot be suspended, but its clock can: while paused, every frame and timer the game
    // asked for is held and handed over on resume, so a loop stops advancing instead of racing on
    // under a button that claims it stopped.

    var paused = false;
    var held = [];

    function gate(schedule) {
        return function (callback) {
            var rest = Array.prototype.slice.call(arguments, 1);
            var args = [
                function () {
                    var fired = arguments;
                    if (paused) {
                        held.push(function () {
                            callback.apply(null, fired);
                        });
                    } else {
                        callback.apply(null, fired);
                    }
                },
            ];
            return schedule.apply(window, args.concat(rest));
        };
    }

    var realFrame = window.requestAnimationFrame.bind(window);
    var realTimeout = window.setTimeout.bind(window);
    var realInterval = window.setInterval.bind(window);
    window.requestAnimationFrame = gate(realFrame);
    window.setTimeout = gate(realTimeout);
    window.setInterval = gate(realInterval);

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (!data || data.source !== FROM_EDITOR) return;
        if (data.type === 'pause') paused = true;
        if (data.type === 'resume') {
            paused = false;
            var waiting = held;
            held = [];
            waiting.forEach(function (run) {
                run();
            });
        }
    });

    // ---- the module graph
    //
    // Blob urls, built dependency-first, because a module's own url has to exist before the one
    // importing it can name it. That is also why a cycle is refused here rather than hanging: this
    // frame has no module resolver to hand one to.

    var SPECIFIER = /(\bfrom\s*|\bimport\s*|\bimport\(\s*)(['"])(\.[^'"]*)\2/g;

    function directoryOf(path) {
        var cut = path.lastIndexOf('/');
        return cut === -1 ? '' : path.slice(0, cut);
    }

    function resolve(from, specifier) {
        var parts = (directoryOf(from) + '/' + specifier).split('/');
        var out = [];
        for (var at = 0; at < parts.length; at += 1) {
            var part = parts[at];
            if (part === '' || part === '.') continue;
            if (part === '..') out.pop();
            else out.push(part);
        }
        return out.join('/');
    }

    function sourceFor(modules, name) {
        var candidates = [name, name + '.js', name + '/index.js'];
        for (var at = 0; at < candidates.length; at += 1) {
            if (Object.prototype.hasOwnProperty.call(modules, candidates[at]))
                return candidates[at];
        }
        return undefined;
    }

    function link(modules, name, urls, open) {
        if (urls[name]) return urls[name];
        if (open.indexOf(name) !== -1) {
            throw new Error('these files import each other: ' + open.concat(name).join(' -> '));
        }

        var code = modules[name].replace(SPECIFIER, function (match, keyword, quote, specifier) {
            var target = sourceFor(modules, resolve(name, specifier));
            if (target === undefined) {
                throw new Error(
                    'nothing in this game is at ' + specifier + ', imported by ' + name,
                );
            }
            return keyword + quote + link(modules, target, urls, open.concat(name)) + quote;
        });

        urls[name] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        return urls[name];
    }

    var run = JSON.parse(document.getElementById('grove-run').textContent);

    post({ type: 'ready' });
    try {
        var entry = link(run.modules, run.entry, {}, []);
        import(entry).catch(function (failure) {
            post({ type: 'error', text: render(failure, 0) });
        });
    } catch (failure) {
        post({ type: 'error', text: render(failure, 0) });
    }
})();
