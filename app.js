var express = require('express'),
    favicon = require('serve-favicon'),
    request = require('request'),
    config = require('./config.json');
    passport = require('passport'),
    bodyParser = require('body-parser'),
    crypto = require('crypto'),
    marked = require('marked'),
    FBStrategy = require('passport-facebook'),
    VKStrategy = require('passport-vkontakte').Strategy,
    qs = require('querystring'),
    requestIp = require('request-ip'),
    UAParser = require('ua-parser-js'),
    raven = require('raven');

var app = express();

app.listen(process.env.PORT || config.port);

app.use(raven.middleware.express.requestHandler(process.env.SENTRY_DSN));
app.use(bodyParser.urlencoded({extended: false}));
app.use(favicon(__dirname + '/favicon.ico'));
app.use(express.static(__dirname + '/public'));
app.use(require('morgan')('dev'));
app.use(require('express-session')(config.session));
app.use(passport.initialize());
app.use(passport.session());
app.engine('hbs', require('express-handlebars')({extname: 'hbs', defaultLayout: 'layout'}));
app.set('view engine', 'hbs');

app.use(function(req, res, next) {
    res.locals.config = config;
    res.locals.user = req.user;
    next();
});

if (process.env.MTSAR_API_URL) config.apiURL = process.env.MTSAR_API_URL;

function auth(req, res, next) {
    if (req.user) {
        next();
    } else {
        switch (config.auth) {
            case 'social':
                res.redirect('/auth/login');
                break;
            default:
                var ip = requestIp.getClientIp(req);
                var parser = new UAParser();
                var browser = parser.setUA(req.headers['user-agent']).getBrowser();
                if (browser.version) {
                    var browserVersion = Number(browser.version.split(".", 1).toString());
                    req.user = {id: `ip${ip}_${browser.name}.${browserVersion}`};
                } else {
                    req.user = {id: `ip${ip}_${browser.name}`};
                }
                next();
                break;
        }
    }
}

app.get('/about', function(req, res, next) {
    res.render('about');
});

if (!config.disabled) {
    app.get('/', auth, function(req, res, next) {
        processes = null;
        getProcesses(function(err, processes) {
            if (err) return next(err);
            res.render('processes', {processes: processes});
        });
    });

    app.get('/:process', auth, checkProcess, function(req, res, next) {
        getProcesses(function(err, processes) {
            if (err) return next(err);

            var process = processes.filter(function(p) { return p.id == req.params.process; })[0];
            var tasksPerPage = process.options.tasksPerPage || 1;

            var tasksURL;
            if (tasksPerPage > 1) {
                tasksURL = config.apiURL + '/processes/' + req.params.process + '/workers/' + req.user.worker + '/tasks/' + tasksPerPage;
            } else {
                tasksURL = config.apiURL + '/processes/' + req.params.process + '/workers/' + req.user.worker + '/task';
            }

            request.get(tasksURL, function(err, data, body) {
                if (err) {
                    return next(err);
                } else if (data.statusCode === 204) {
                    return res.render('empty', {worker: req.user.worker});
                }

                if (!!body.tasks) {
                    var token = tasksToken(body.tasks.map(t => t.id));

                    body.tasks.forEach(function(task) {
                        if (process.id == 'russe') task.description = task.tags.map(t => `<a href="https://www.google.com/search?q=%22${t}%22" target="_blank">${t}</a>`).join(' и ');
                        task.descriptionHTML = marked(task.description);
                        task.inputType = (task.type == 'single') ? 'radio' : 'checkbox';
                        task.answers = task.answers.map(answer => {
                            return {value: answer};
                        });
                        switch (process.id) {
                        case 'russe':
                        case 'gsm-genus':
                        case 'gsm-species':
                        case 'gsm-match':
                            task.answer = 0;
                            break;
                        default:
                            break;
                        }
                    });

                    switch (process.id) {
                    case 'russe':
                        res.render('russe', {process: process, allocation: body, token: token})
                        break;
                    case 'gsm-genus':
                    case 'gsm-species':
                    case 'gsm-match':
                        res.render('genus-species', {process: process, allocation: body, token: token})
                        break;
                    default:
                        res.render('task', {process: process, allocation: body, token: token})
                        break;
                    }
                } else {
                    res.render('empty', {worker: req.user.worker});
                }
            }).json();
        });
    });

    app.post('/:process', auth, checkProcess, function(req, res, next) {
        var tasks = (Array.isArray(req.body.task)) ? req.body.task: [req.body.task];

        var answers = {};
        tasks.forEach(function(task) {
            var key = "answers[" + task + "]";
            answers[task] = req.body[key] ? (Array.isArray(req.body[key]) ? req.body[key] : [req.body[key]]) : null;
        });

        var token = tasksToken(tasks);
        if (req.body.token != token) return res.redirect(`/${req.params.process}`);

        request.patch(`${config.apiURL}/processes/${req.params.process}/workers/${req.user.worker}/answers`, {form: {
            answers: answers,
            tags: `tasks${tasks.join('_')}`
        }}, function(err, data, body) {
            var errors = localizeValidationErrors(JSON.parse(body).errors);
            if (errors.length > 0) {
                var process = {id: req.params.process};
                var query = qs.stringify({task_id: tasks});
                request.get(`${config.apiURL}/processes/${req.params.process}/workers/${req.user.worker}/tasks?${query}`, function(err, data, body) {
                    if (err) {
                        return next(err);
                    } else if (data.statusCode === 204) {
                        return res.render('empty', {worker: req.user.worker});
                    }

                    token = tasksToken(body.tasks.map(t => t.id));

                    body.tasks.forEach(function(task) {
                        if (process.id == 'russe') task.description = task.tags.map(t => `<a href="https://www.google.com/search?q=%22${t}%22" target="_blank">${t}</a>`).join(' и ');
                        task.descriptionHTML = marked(task.description);
                        task.inputType = (task.type == 'single') ? 'radio' : 'checkbox';
                        task.answers = task.answers.map(answer => {
                            return {value: answer, checked: (answers[task.id.toString()] || []).indexOf(answer) !== -1};
                        });
                        switch (process.id) {
                        case 'russe':
                        case 'gsm-genus':
                        case 'gsm-species':
                        case 'gsm-match':
                            task.answer = (answers[task.id.toString()] || 0)[0] || 0;
                            break;
                        default:
                            break;
                        }
                    });

                    switch (process.id) {
                    case 'russe':
                        res.render('russe', {process: process, allocation: body, errors: errors, token: token})
                        break;
                    case 'gsm-genus':
                    case 'gsm-species':
                    case 'gsm-match':
                        res.render('genus-species', {process: process, allocation: body, errors: errors, token: token})
                        break;
                    default:
                        res.render('task', {process: process, allocation: body, errors: errors, token: token})
                        break;
                    }
                }).json();
            } else {
                res.redirect('/' + req.params.process);
            }
        });
    });

    app.get('/auth/login', function(req, res, next) {
        res.render('login');
    });
} else {
    app.get('/', function(req, res, next) {
        res.render('disabled');
    });
}


function tasksToken(tasks) {
    return crypto.createHash('sha256').
        update(tasks.sort().join('_') + 'russe2015').
        digest('hex');
}

var processes;

function getProcesses(next) {
    if (!!processes) return next(null, processes);
    request.get(config.apiURL + '/processes', function(err, data, body) {
        if (err) {
            return next(err);
        }

        if (config.processes) {
            processes = JSON.parse(body).filter(function(item) {
                return config.processes.indexOf(item.id) !== -1;
            }).sort(function(a, b) {
                return config.processes.indexOf(a.id) > config.processes.indexOf(b.id);
            });
        } else {
            processes = JSON.parse(body);
        }

        processes.forEach(function(item) {
            item.descriptionHTML = marked(item.description);
        });

        next(null, processes);
    });
}

function checkProcess(req, res, next) {
    if (config.processes && config.processes.indexOf(req.params.process) === -1) {
        return res.status(404).end();
    }

    if (req.user.process !== req.params.process) {
        findOrCreateWorker(req.params.process, req.user.id, function(err, worker) {
            if (err) {
                return next(err);
            }

            req.user.process = req.params.process;
            req.user.worker = worker.id;
            next();
        });
    } else {
        next();
    }
}

function findOrCreateWorker(process, tag, done) {
    var processURL = config.apiURL + '/processes/' + process;

    request.get(processURL + '/workers/tagged/' + encodeURIComponent(tag), function(err, data, body) {
        if (data.statusCode === 204) {
            request.post(processURL + '/workers', {form: {tags: tag}}, function(err, data, body) {
                try {
                    done(err, JSON.parse(body));
                } catch (err) {
                    done(err);
                }
            });
        } else {
            done(err, body);
        }
    }).json();
}

function localizeValidationErrors(errors) {
    return (errors || []).map(function(error) {
        var id = (error.match(/^#(.+?):/) || [])[1];
        switch (id) {
            case "task-single-no-answer":
                return "Необходимо выбрать один из ответов.";
            case "answer-not-in-task":
                return "Указан недопустимый вариант ответа.";
            case "answer-duplicate":
                return null;
            default:
                return null;
        }
    }).filter(function(e) { return !!e; });
}

// auth

passport.serializeUser(function(user, done) {
    done(null, {id: user.id});
});

passport.deserializeUser(function(user, done) {
    done(null, user);
});

if (config.auth == 'social') {
    passport.use(new FBStrategy(config.facebook, function(accessToken, refreshToken, profile, done) {
        done(null, {id: 'facebook' + profile.id});
    }));

    app.get('/auth/fb', passport.authenticate('facebook'));
    app.get('/auth/fbcallback', passport.authenticate('facebook', {successRedirect: '/'}));

    passport.use(new VKStrategy(config.vkontakte, function(accessToken, refreshToken, profile, done) {
        done(null, {id: 'vkontakte' + profile.id});
    }));

    app.get('/auth/vk', passport.authenticate('vkontakte'));
    app.get('/auth/vkcallback', passport.authenticate('vkontakte', {successRedirect: '/'}));

    app.get('/auth/logout', function(req, res, next) {
        req.logout();
        res.redirect('/');
    });
}

// handle 404

app.use(function(req, res, next) {
    res.status(404).end('404');
});

// handle errors

app.use(raven.middleware.express.errorHandler(process.env.SENTRY_DSN));

app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error');
    console.log(err);
});
