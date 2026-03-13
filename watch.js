const params = new URLSearchParams(window.location.search);
const episodeId = params.get("ep");

const player = document.getElementById("player");
const title = document.getElementById("epTitle");

async function loadEpisode(){

if(!episodeId) return;

title.innerText = "Episode " + episodeId;

const res = await fetch(
"https://api.consumet.org/anime/gogoanime/watch/" + episodeId
);

const data = await res.json();

player.src = data.sources[0].url;

}

loadEpisode();
