//+------------------------------------------------------------------+
//| ExportTicksCSV.mq5                                                |
//| MT5 → CSV ticks for Super Alpha tick backtest                     |
//|                                                                   |
//| 1) Attach to EURUSD / XAUUSD / GBPUSD chart                       |
//| 2) Set InpFrom / InpTo (server time) — e.g. 6 months              |
//| 3) Run → Common\Files\SA_ticks_{SYMBOL}.csv                       |
//| 4) Import:                                                        |
//|    npx tsx scripts/import-mt5-ticks.ts SA_ticks_XAUUSD.csv XAUUSD |
//|                                                                   |
//| NOTE: CopyTicksRange is chunked. Do NOT break when n > InpChunk.  |
//+------------------------------------------------------------------+
#property copyright "Super Alpha"
#property version   "1.01"
#property script_show_inputs

input datetime InpFrom = D'2026.01.01 00:00:00';
input datetime InpTo   = D'2026.07.28 23:59:59';
input int      InpChunk = 100000; // max ticks written per CopyTicksRange call

string TimeStr(datetime t, int msec)
{
   MqlDateTime dt;
   TimeToStruct(t, dt);
   string ms = IntegerToString(msec, 3, '0');
   return StringFormat("%04d.%02d.%02d %02d:%02d:%02d.%s",
                       dt.year, dt.mon, dt.day, dt.hour, dt.min, dt.sec, ms);
}

void OnStart()
{
   string sym = _Symbol;
   string path = "SA_ticks_" + sym + ".csv";
   int h = FileOpen(path, FILE_WRITE|FILE_CSV|FILE_ANSI|FILE_COMMON, ',');
   if(h == INVALID_HANDLE)
   {
      Print("FileOpen failed ", GetLastError());
      return;
   }
   FileWrite(h, "Time", "Bid", "Ask", "Last", "Volume", "Flags");

   datetime from = InpFrom;
   datetime to   = InpTo;
   long total = 0;
   int rounds = 0;

   while(from < to)
   {
      MqlTick ticks[];
      // request from→to; broker may return a capped batch
      int n = CopyTicksRange(sym, ticks, COPY_TICKS_ALL, (ulong)from * 1000, (ulong)to * 1000);
      if(n <= 0)
      {
         Print("CopyTicksRange returned ", n, " err=", GetLastError(),
               " from=", TimeToString(from), " total_so_far=", total);
         break;
      }

      int use = MathMin(n, InpChunk);
      for(int i = 0; i < use; i++)
      {
         datetime sec = (datetime)(ticks[i].time_msc / 1000);
         int msec = (int)(ticks[i].time_msc % 1000);
         FileWrite(h,
                   TimeStr(sec, msec),
                   DoubleToString(ticks[i].bid, _Digits),
                   DoubleToString(ticks[i].ask, _Digits),
                   DoubleToString(ticks[i].last, _Digits),
                   (string)ticks[i].volume,
                   (string)ticks[i].flags);
      }
      total += use;
      rounds++;

      ulong lastMs = ticks[use - 1].time_msc + 1;
      datetime nextFrom = (datetime)(lastMs / 1000);
      if(nextFrom <= from)
      {
         // safety: avoid infinite loop if time does not advance
         nextFrom = from + 1;
      }
      from = nextFrom;

      Print("chunk#", rounds, " wrote=", use, " total=", total,
            " next_from=", TimeToString(from));

      // last partial batch → done for this range
      if(use < InpChunk)
         break;
      // if broker returned exactly InpChunk, keep looping until from>=to
   }

   FileClose(h);
   Print("DONE ", path, " ticks=", total, " rounds=", rounds, " (Common\\\\Files)");
}
