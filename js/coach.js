// Turns "that move throws the result away" into the principle behind it.
// Every message says what to do next time, not just what went wrong.
import { file, rank, chebyshev, inOpposition, frontSquare, promoSquare, isRookPawn } from './kpgen.js';

const sq = name => 'abcdefgh'.indexOf(name[0]) + (Number(name[1]) - 1) * 8;

const cornerFor = p => (file(p) === 0 ? sq('a8') : sq('h8'));

// Could a king move have taken the opposition instead? Only king moves count:
// telling someone to "face their king" after a pawn push reads as nonsense.
function oppositionWasAvailable(options, mover) {
  return options.some(o => o.move.piece === 'k'
    && inOpposition(mover === 'w' ? o.state.wk : o.state.bk,
                    mover === 'w' ? o.state.bk : o.state.wk));
}

function movedTo(options, target, mover) {
  return options.some(o => (mover === 'w' ? o.state.wk : o.state.bk) === target);
}

// --- Why a move loses the result -----------------------------------------
export function diagnose({ drillId, before, after, move, correct }) {
  const pawn = before.p;
  const front = frontSquare(pawn);
  const promo = promoSquare(pawn);

  if (drillId === 'promote') {
    // The pawn ran ahead of its escort.
    if (move.piece === 'p') {
      return {
        principle: 'The pawn is not the escort',
        text: 'Walk your king in front of the pawn first and keep it there. Push the pawn only while it stays behind your king \u2014 to win a tempo and hand the move back to them \u2014 or once nothing can stop it from queening.',
      };
    }

    const kingMoves = correct.filter(o => o.move.piece === 'k');
    const closer = kingMoves.some(o => chebyshev(o.state.wk, promo) < chebyshev(after.wk, promo));
    const retreated = chebyshev(after.wk, promo) > chebyshev(before.wk, promo);
    const lead = {
      principle: 'King leads, toward the queening square',
      text: `March your king up the board ahead of the pawn, toward ${'abcdefgh'[file(pawn)]}8 and the squares around it. Your king has to clear the path before the pawn can travel, so every king move should be closing in on them.`,
    };

    if (retreated && closer) return lead;
    if (oppositionWasAvailable(correct, 'w')) {
      return {
        principle: 'Take the opposition',
        text: 'Put your king directly facing theirs with one square between, on the same file or rank. Whoever does not have to move holds the opposition, so they are the one forced to give way and let you through.',
      };
    }
    if (closer) return lead;
    return {
      principle: 'Outflank them',
      text: 'When their king steps aside, step diagonally forward to the other side. That wins the squares in front of your pawn and keeps them from blocking it.',
    };
  }

  if (drillId === 'square') {
    const closer = correct.some(o => chebyshev(o.state.bk, promo) < chebyshev(after.bk, promo));
    if (closer) {
      return {
        principle: 'Stay inside the square',
        text: `Count the squares from the pawn to ${'abcdefgh'[file(pawn)]}8, and picture a box of that size reaching across toward your king. Every move has to keep your king inside that box, so move straight at the queening square — a diagonal step that closes in on the pawn and the box at once.`,
      };
    }
    return {
      principle: 'Stay inside the square',
      text: `Head for ${'abcdefgh'[file(pawn)]}8 by the shortest route. Each king move must cut the distance to the queening square, or the pawn simply outruns you.`,
    };
  }

  if (drillId === 'rookpawn') {
    const corner = cornerFor(pawn);
    return {
      principle: 'Run to the corner',
      text: `With an ${'abcdefgh'[file(pawn)]}-pawn there is no file on the far side for their king to outflank you on, so the corner is a fortress. Get your king to ${'abcdefgh'[file(corner)]}8 or the square beside it and shuffle there — they can never force you out without stalemating you.`,
    };
  }

  // drillId === 'hold'
  if (movedTo(correct, front, 'b')) {
    return {
      principle: 'Stand in front of the pawn',
      text: 'Whenever the square directly in front of the pawn is free and safe, step onto it. Blocking the pawn is what stops it; chasing their king around the side is what loses.',
    };
  }
  if (file(before.bk) === file(pawn) && file(after.bk) !== file(pawn)
      && correct.some(o => file(o.state.bk) === file(pawn))) {
    return {
      principle: 'Retreat straight back',
      text: 'Step straight back along the pawn’s own file. From there you can take the opposition whichever side their king picks; stepping off the file hands them one side for free.',
    };
  }
  if (oppositionWasAvailable(correct, 'b')) {
    return {
      principle: 'Take the opposition',
      text: 'When their king steps up beside the pawn, move your king directly opposite it with one square between. They then have to move first and give ground.',
    };
  }
  return {
    principle: 'Block, then take the opposition',
    text: 'Keep your king on the pawn’s file: stand in front of the pawn when you can, step straight back when it advances, and face their king when it comes up the side.',
  };
}

// --- What a good move just did -------------------------------------------
export function label({ drillId, before, after, move }) {
  const pawn = before.p;
  const promo = promoSquare(pawn);
  const mover = before.stm === 0 ? 'w' : 'b';

  if (mover === 'w') {
    if (move.piece === 'p') {
      return rank(after.p) < rank(after.wk) ? 'a tempo move, pawn still behind the king' : 'a pawn push';
    }
    if (inOpposition(after.wk, after.bk)) return 'the opposition';
    if (rank(after.wk) > rank(before.wk) && file(after.wk) !== file(before.wk)) return 'an outflanking step';
    return 'king first';
  }

  if (after.bk === frontSquare(pawn)) return 'blocking the pawn';
  if (drillId === 'square' || chebyshev(after.bk, promo) < chebyshev(before.bk, promo)) {
    if (drillId === 'rookpawn') return 'heading for the corner';
    return 'staying inside the square';
  }
  if (inOpposition(after.wk, after.bk)) return 'the opposition';
  if (file(after.bk) === file(pawn) && file(before.bk) === file(pawn)) return 'straight back on the pawn’s file';
  return 'holding on';
}
