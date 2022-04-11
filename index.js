const { ethers, Signer } = require("ethers");
require("dotenv").config();
require("log-timestamp");
const _ = require("lodash");
const axios = require("axios");

const { BigNumber } = ethers;
const { parseEther, formatEther, parseUnits } = ethers.utils;

// params
const X = parseEther("0.3");
const SLIPPAGE = 60; // in percentage
const LAST_Y_NUM = 20;
const NUM_SD = 150; // in percentage
const WAIT_FOR_NO_RESP = 1 * 60 * 1e3;

RPC = "https://rpc.ankr.com/fantom";
// RPC = "https://rpcapi.fantom.network"
CHAIN_ID = 250;
ADDRESS_TICKET = "0x97DeB227e81533882BeE467f7EE67fDCb8EF2126";
ADDRESS_AUCTION = "0xD5D5C07CC2A21fce523b8C16B51F769B0aFa08B4";
PRIVATE_KEY = process.env["PRIVATE_KEY"];
USER_ADDRESS = process.env["ADDRESS"];
GAS_ORACLE_API_KEY = process.env["GAS_ORACLE_API_KEY"];

// function signature
TOKEN_ABI = ["function balanceOf(address owner) view returns (uint256)"];
AUCTION_ABI = [
  "function swap(uint x, uint minY) public returns (uint y)",
  "function getY(uint x) public view returns (uint)",
];

const provider = new ethers.providers.JsonRpcProvider(RPC, {
  chainId: CHAIN_ID,
});
const walletWithoutProvider = new ethers.Wallet(PRIVATE_KEY);
const wallet = walletWithoutProvider.connect(provider);

const ticketContract = new ethers.Contract(ADDRESS_TICKET, TOKEN_ABI, wallet);
const auctionContract = new ethers.Contract(
  ADDRESS_AUCTION,
  AUCTION_ABI,
  wallet
);

const calculateExpectedY = ((numSd) => (lastYs) => {
  const sum = (bns) =>
    _.reduce(bns, (prev, curr) => prev.add(curr), BigNumber.from(0));
  const avg = (bns) => sum(bns).div(BigNumber.from(bns.length));

  const minus = (val) => (bn) => bn.sub(val);
  const square = (bn) => bn.pow(2);
  const minusThenSquare = (val) => _.flow(minus(val), square);
  const summationOfDiff = (bns, val) => sum(_.map(bns, minusThenSquare(val)));
  const sqrt = (value) => {
    x = BigNumber.from(value);
    let z = x.add(BigNumber.from(1)).div(BigNumber.from(2));
    let y = x;
    while (z.sub(y).isNegative()) {
      y = z;
      z = x.div(z).add(z).div(BigNumber.from(2));
    }
    return y;
  };
  const sd = (bns, mu) =>
    sqrt(summationOfDiff(bns, mu).div(BigNumber.from(bns.length)));
  const mu = avg(lastYs);
  const sigma = sd(lastYs, mu);
  return mu.add(sigma.mul(BigNumber.from(numSd).div(BigNumber.from(100))));
})(NUM_SD);

const appendToLastNumOfElem = (
  (num) => (lastY, currY) =>
    [...lastY.slice(-(num - 1)), currY]
)(LAST_Y_NUM);

const calculateMinY = (y, slippage) =>
  y
    .mul(BigNumber.from(100).sub(BigNumber.from(slippage)))
    .div(BigNumber.from(100));

const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1e3));

let lastStamp = _.now();

const checkIfNoResp = async (exit = false) => {
  if (_.now() - lastStamp > WAIT_FOR_NO_RESP) {
    if (exit) {
      console.log("exiting");
      process.exit();
    }

    // sleep for 1 minute then exit, wait for forver to restart the process
    console.log(
      "more than one minute no response, exiting after one minute if no more response"
    );
    await sleep(1 * 60);
    await checkIfNoResp(true);
  }
};

const start = (lastYs, callCount = 0) => {
  provider.once("block", async () => {
    // exit the script after 3 minutes no successful response
    checkIfNoResp();
    const y = await auctionContract.getY(X);
    const balance = await ticketContract.balanceOf(USER_ADDRESS);

    let tx;
    let confirmed = false;
    if (balance.gte(BigNumber.from(0)) && y.gte(calculateExpectedY(lastYs))) {
      try {
        const minY = calculateMinY(y, SLIPPAGE);
        tx = await auctionContract.swap(X, minY);
        console.log(
          `i can get ${formatEther(y)} $medal, at least ${formatEther(minY)}`
        );
        console.log(`sending transaction nonce ${tx.nonce}, hash ${tx.hash}`);
      } catch (err) {
        console.error("error when submitting request", err);
      }

      // avoid ftm getting stuck
      // make transaction async first
      tx.wait()
        .then(() => {
          console.log(`txHash ${tx.hash} is successful`);
          lastStamp = _.now();
          confirmed = true;
        })
        .catch((err) => {
          console.error(err);
          confirmed = true;
        });

      // this is to wait for certain seconds to see if there is response
      const sleepAndCheckTx = async (time = 0) => {
        console.log(`waited for ${time} second(s)`);
        await sleep(1);
        // check if there is no response, then restart the process
        checkIfNoResp();
        // if the trade is successful, return
        if (confirmed) {
          return;
        }
        await sleepAndCheckTx(time + 1);
      };
      await sleepAndCheckTx();
      start(appendToLastNumOfElem(lastYs, y), callCount + 1);
      return;
    }
    // wait for 1 second to trigger the next block
    await sleep(1);
    start(appendToLastNumOfElem(lastYs, y), callCount + 1);
  });
};
(async () => {
  try {
    const y = await auctionContract.getY(X);
    start([y]);
  } catch (err) {
    console.error(err);
  }
})();
