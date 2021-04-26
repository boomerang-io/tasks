const log = require("./log");
const { CloudEvent } = require("cloudevents");

function protectAgainstEmpty(input) {
    if (input && typeof input === "string" && input === '""') {
      return undefined;
    }
    return input;
}

module.exports = {
    getCloudEvent: (eventSubject, eventType, eventPayload) => {
        log.debug("Creating cloud event, type:", eventType);
        log.debug("process.cloudEventsContext:", process.cloudEventsContext);
        if (!process.cloudEventsContext || !process.cloudEventsContext.source) {
            //defaulting the source to a basis source if not set
            process.cloudEventsContext = {
                source: "boomerang-io/worker.flow"
            };
            log.warn("Defaulting the event source, to:", process.cloudEventsContext.source);
        }
        if (!protectAgainstEmpty(eventType)) {
            eventType = "Generic";
        }
        const ce = new CloudEvent({
            type: eventType,
            source: process.cloudEventsContext.source
        });
        ce["source"] = "boomerang-io/worker.flow/unknown";
        if (protectAgainstEmpty(eventSubject)) {
            ce["subject"] = eventSubject;
        }
        if (protectAgainstEmpty(eventPayload)) {
            ce["data"] = eventPayload;
        }

        return ce;
    }

}