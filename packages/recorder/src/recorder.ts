import { watchers } from './watchers'
import { RecordAudio } from './audio'
import { RecordData, RecordOptions, ValueOf, RecordType, RecordInternalOptions, TerminateRecord } from '@timecat/share'
import { getDBOperator, logError, Transmitter, getRadix64TimeStr, IndexedDBOperator } from '@timecat/utils'
import { Snapshot } from './snapshot'
import { getHeadData } from './head'
import { Pluginable } from './pluginable'

export class Recorder extends Pluginable {
    private static defaultRecordOpts = { mode: 'default', write: true, context: window } as RecordOptions
    private reverseStore: Set<Function> = new Set()
    private onDataCallback: Function
    private db: IndexedDBOperator

    constructor(options?: RecordOptions) {
        super(options)
        const opts = { ...Recorder.defaultRecordOpts, ...options } as RecordInternalOptions

        // TODO: Plugin module
        if (opts && opts.uploadUrl) {
            new Transmitter(opts.uploadUrl)
        }

        this.init(opts)
    }

    private async init(options: RecordInternalOptions) {
        const db = await getDBOperator
        this.db = db
        this.hooks.beforeRun.call(this)
        this.record(options)
        this.hooks.run.call(this)
        this.listenVisibleChange(options)
    }

    public onData(cb: (data: RecordData) => void) {
        this.onDataCallback = cb
    }

    public unsubscribe() {
        this.reverseStore.forEach(un => un())
    }

    private getRecorders(options: RecordOptions) {
        const recorders: Array<ValueOf<typeof watchers> | typeof RecordAudio | typeof Snapshot> = [
            Snapshot,
            ...Object.values(watchers)
        ]
        if (options && options.audio) {
            recorders.push(RecordAudio)
        }
        return recorders
    }

    public record(options: RecordOptions): void
    public record(options: RecordInternalOptions): void

    public record(options: RecordOptions): void {
        const opts = { ...Recorder.defaultRecordOpts, ...options } as RecordInternalOptions
        this.startRecord((opts.context.G_RECORD_OPTIONS = opts))
    }

    private async startRecord(options: RecordInternalOptions) {
        const allRecorders = this.getRecorders(options)
        let iframeWatchers = allRecorders

        // is record iframe, switch context
        if (options.context === window) {
            if (!options.skip) {
                this.db.clear()
            }
        } else {
            iframeWatchers = [
                Snapshot,
                watchers.MouseWatcher,
                watchers.DOMWatcher,
                watchers.FormElementWatcher,
                watchers.ScrollWatcher
            ]
        }

        const onEmit = (options: RecordOptions) => {
            const { write } = options
            return (data: RecordData) => {
                if (!data) {
                    return
                }

                this.hooks.emit.call(data)

                this.onDataCallback && this.onDataCallback(data)

                if (write) {
                    this.db.addRecord(data)
                }
            }
        }

        const emit = onEmit(options)

        const headData = await getHeadData()

        const relatedId = headData.relatedId
        if (options.context) {
            options.context.G_RECORD_RELATED_ID = relatedId
        }
        emit({
            type: RecordType.HEAD,
            data: headData,
            relatedId: relatedId,
            time: getRadix64TimeStr()
        })

        iframeWatchers.forEach(watcher => {
            new watcher({
                context: options && options.context,
                reverseStore: this.reverseStore,
                relatedId: relatedId,
                emit
            })
        })

        await this.recordFrames()
    }

    private async waitingFramesLoaded() {
        const frames = window.frames
        const tasks = Array.from(frames)
            .filter(frame => {
                try {
                    const frameElement = frame.frameElement
                    return frameElement.getAttribute('src')
                } catch (e) {
                    logError(e)
                    return false
                }
            })
            .map(frame => {
                const frameDocument = frame
                return new Promise(resolve => {
                    frameDocument.addEventListener('load', () => {
                        resolve(frame)
                    })
                })
            })
        if (!tasks.length) {
            return Promise.resolve([])
        }
        return Promise.all(tasks) as Promise<Window[]>
    }

    private async recordFrames() {
        const frames = await this.waitingFramesLoaded()
        frames.forEach(frameWindow => this.record({ context: frameWindow }))
    }

    private listenVisibleChange(this: Recorder, options: RecordInternalOptions) {
        if (typeof document.hidden !== 'undefined') {
            const hidden = 'hidden'
            const visibilityChange = 'visibilitychange'

            async function handleVisibilityChange(this: Recorder) {
                if (document[hidden]) {
                    const data = {
                        type: RecordType.TERMINATE,
                        data: null,
                        relatedId: options.context.G_RECORD_RELATED_ID,
                        time: getRadix64TimeStr()
                    }
                    this.db.addRecord(data as TerminateRecord)
                    this.onDataCallback && this.onDataCallback(data)
                    this.unsubscribe()
                    this.hooks.end.call()
                } else {
                    this.record({ ...options, skip: true } as RecordInternalOptions)
                }
            }

            document.addEventListener(visibilityChange, handleVisibilityChange.bind(this), false)

            this.reverseStore.add(() =>
                document.removeEventListener(visibilityChange, handleVisibilityChange.bind(this), false)
            )
        }
    }
}
