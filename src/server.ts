import dayjs from "dayjs";
import fastify from "fastify";
import got from "got";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { Transform, Readable, Writable } from "stream";
import fastifyStatic from "fastify-static";
import { join as pathJoin } from "path";
import fastifySocketIO from "fastify-socket.io";

dayjs.extend(utc);
dayjs.extend(timezone);

const PINS = ["690518"];
const DISTRICT_ID = "298"; // Kollam
const DISTRICT_NAME = "Kollam";
const POLL_INTERVAL = 1000 * 7;
const MIN_AGE = 18;

let lastPolledAt: null | Date = null;
let lastResult: any;

const server = fastify({
  logger: true,
});

server.register(fastifyStatic, {
  root: pathJoin(__dirname, "public"),
  prefix: "/",
});

server.register(fastifySocketIO, {});

const start = async () => {
  try {
    await server.listen(3000);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

server.ready((err) => {
  if (err) {
    throw err;
  }
  // io connections
  (server as any).io.on("connection", () => {
    server.log.info("New client connected!");
    setTimeout(() => {
      if (lastResult) {
        server.io.emit("new-data", lastResult);
      }
    }, 1000);
  });

  initializePipeline();
});

function initializePipeline() {
  PollStream.pipe(Unwind)
    .pipe(Filter)
    .on("error", (err) => {
      errorSender(err);
    })
    .pipe(Publisher)
    .on("error", (err) => {
      errorSender(err);
    });
}

function errorSender(err: any) {
  console.error(err);
  server.io.emit("error", err?.name || "some errors");
}

function filterResponse(resp: (Center & Session)[]) {
  const freeInDistrict: (Center & Session)[] = [];
  const freeInPIN: (Center & Session)[] = [];
  const paidInPIN: (Center & Session)[] = [];

  resp.forEach((item) => {
    // omit if no available capacity
    if (!item.available_capacity) {
      return;
    }

    // filter out other district
    if (item.district_name !== DISTRICT_NAME) {
      return;
    }

    // min 18
    if (!item.allow_all_age && item.min_age_limit >= MIN_AGE) {
      return;
    }

    // in PIN
    if (PINS.includes(item.pincode.toString())) {
      if (item.fee_type === "Free") {
        freeInPIN.push(item);
      } else {
        paidInPIN.push(item);
      }
    }

    // free in district
    if (item.fee_type === "Free") {
      freeInDistrict.push(item);
    }
  });

  return { freeInDistrict, freeInPIN, paidInPIN };
}

const Publisher = new Writable({
  write(chunk, enc, cb) {
    lastResult = chunk;
    chunk.updatedAt = lastPolledAt;
    server.io.emit("new-data", chunk);
    cb();
  },
  objectMode: true,
});

const Filter = new Transform({
  transform(chunk: (Center & Session)[], enc, cb) {
    const results = filterResponse(chunk);
    this.push(results);
    cb();
  },
  objectMode: true,
});

const Unwind = new Transform({
  transform(chunk: APIResponse, enc, cb) {
    const unwinded: (Center & Session)[] = [];
    chunk.centers?.forEach((center) => {
      center.sessions?.forEach((session) => {
        const merged = Object.assign({}, center, session);
        unwinded.push(merged);
      });
    });
    this.push(unwinded);
    cb();
  },
  objectMode: true,
});

const PollStream = new Readable({
  async read() {
    const resp = await getPollData();
    this.push(resp);
  },
  objectMode: true,
});

async function getPollData() {
  const waitTime = getWaitTime();
  await wait(waitTime);
  return await calendarByPin();
}

function getWaitTime() {
  if (!lastPolledAt) {
    return 0;
  }
  const nextRunAt = new Date(lastPolledAt.getTime() + POLL_INTERVAL);
  const balanceTime = nextRunAt.getTime() - lastPolledAt.getTime();
  return balanceTime;
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function calendarByPin() {
  const dateString = getCurrentDateString();
  const url = `https://cdn-api.co-vin.in/api/v2/appointment/sessions/public/calendarByDistrict?district_id=${DISTRICT_ID}&date=${dateString}`;
  const resp = await got.get(url, { responseType: "json" });
  lastPolledAt = new Date();
  return resp.body;
}

function getCurrentDateString(): string {
  const day = dayjs(new Date()).tz("Asia/Kolkata").format("DD-MM-YYYY");
  return day;
}

interface APIResponse {
  centers?: Center[];
}

interface Center {
  name: string;
  address: string;
  district_name: string;
  pincode: string;
  from: string;
  to: string;
  fee_type: "Free" | "Paid";
  sessions?: Session[];
  vaccine_fees: Array<{ vaccine: string; fee: string }>;
}

interface Session {
  session_id: string;
  date: string;
  available_capacity: number;
  min_age_limit: number;
  allow_all_age: boolean;
  vaccine: string;
  slots: string[];
  available_capacity_dose1: number;
  available_capacity_dose2: number;
}

start();
