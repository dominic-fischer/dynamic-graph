A dynamic visualisation of the social networks found in Swiss Reformer Heinrich Bullinger's correspondence, accessible [here](https://dominic-fischer.github.io/dynamic-graph/).

It is based on the letter corpus digitised as part of the **Bullinger Digital** project ([website](https://www.bullinger-digital.ch/index.html), [repo](https://github.com/bullinger-digital)). The letters contain marked greeting formulas, which are used to infer the social networks surrounding Bullinger. For a detailed description of how these greeting data were processed to produce this visualisation, see [here](https://github.com/dominic-fischer/bullinger-saluta).

There is also an API ([Bullinger Greetings API](https://bullinger-saluta-api.onrender.com/docs#/default/run_run_post)) for those who want to work with the data themselves or are interested in a particular correpondence:

- **Input:** Parameters such as the sender and the addressee
- **Output:** The raw data greeting data between the selected correspondents (amount per year, direction, etc.), as well as a number of potentially relevant illustrations based on these data

**Note**: The visualisation and its documentation are still under development.
<br>
The visualisation is inspired by https://github.com/davidnmora/d3-dynamic-graph.
